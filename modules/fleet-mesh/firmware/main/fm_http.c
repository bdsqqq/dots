#include "fm_http.h"

#include <stdio.h>
#include <stdlib.h>
#include <strings.h>
#include <string.h>

#include "cJSON.h"
#include "esp_http_client.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "fleet-http";
static fm_protocol_t *server_protocol;
static const fm_config_t *server_config;

typedef struct {
    uint8_t *data;
    size_t length;
    bool overflow;
} peer_response_t;

static esp_err_t send_json(httpd_req_t *request, const char *status,
                           const char *body, size_t body_len) {
    httpd_resp_set_status(request, status);
    httpd_resp_set_type(request, "application/json");
    return httpd_resp_send(request, body, body_len);
}

static esp_err_t health_handler(httpd_req_t *request) {
    cJSON *root = cJSON_CreateObject();
    if (!root || !cJSON_AddStringToObject(root, "kind", "fleet.mesh-daemon-health") ||
        !cJSON_AddNumberToObject(root, "version", 1) ||
        !cJSON_AddStringToObject(root, "node", server_config->identity_id)) {
        cJSON_Delete(root);
        return ESP_ERR_NO_MEM;
    }
    char *body = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!body) return ESP_ERR_NO_MEM;
    esp_err_t err = send_json(request, "200 OK", body, strlen(body));
    free(body);
    return err;
}

static esp_err_t gossip_handler(httpd_req_t *request) {
    if (request->content_len <= 0 || request->content_len > FM_BODY_MAX) {
        return send_json(request, "413 Payload Too Large",
                         "{\"error\":\"gossip request exceeds 64 KiB\"}",
                         strlen("{\"error\":\"gossip request exceeds 64 KiB\"}"));
    }
    uint8_t *body = malloc((size_t)request->content_len);
    if (!body) return send_json(request, "503 Service Unavailable",
                                "{\"error\":\"out of memory\"}", 25);
    size_t received = 0;
    while (received < (size_t)request->content_len) {
        int count = httpd_req_recv(request, (char *)body + received,
                                   request->content_len - received);
        if (count == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (count <= 0) { free(body); return ESP_FAIL; }
        received += (size_t)count;
    }
    size_t accepted = 0;
    esp_err_t err = fm_protocol_ingest(server_protocol, body, received, &accepted);
    free(body);
    if (err != ESP_OK) {
        const char *message = err == ESP_ERR_INVALID_ARG || err == ESP_ERR_INVALID_SIZE
                                  ? "{\"error\":\"invalid gossip body\"}"
                                  : "{\"error\":\"gossip state unavailable\"}";
        return send_json(request,
                         err == ESP_ERR_INVALID_ARG || err == ESP_ERR_INVALID_SIZE
                             ? "400 Bad Request" : "503 Service Unavailable",
                         message, strlen(message));
    }
    char *response = NULL;
    size_t response_len = 0;
    err = fm_protocol_gossip_response(server_protocol, accepted, &response, &response_len);
    if (err != ESP_OK) {
        return send_json(request, "507 Insufficient Storage",
                         "{\"error\":\"gossip response exceeds 64 KiB\"}",
                         strlen("{\"error\":\"gossip response exceeds 64 KiB\"}"));
    }
    err = send_json(request, "200 OK", response, response_len);
    free(response);
    return err;
}

static esp_err_t response_event(esp_http_client_event_t *event) {
    peer_response_t *response = event->user_data;
    if (event->event_id == HTTP_EVENT_ON_HEADER && event->header_key &&
        event->header_value && strcasecmp(event->header_key, "Content-Length") == 0 &&
        strtoull(event->header_value, NULL, 10) > FM_BODY_MAX) {
        response->overflow = true;
        return ESP_FAIL;
    }
    if (event->event_id != HTTP_EVENT_ON_DATA || event->data_len == 0) return ESP_OK;
    if (response->overflow || (size_t)event->data_len > FM_BODY_MAX - response->length) {
        response->overflow = true;
        return ESP_FAIL;
    }
    uint8_t *grown = realloc(response->data, response->length + (size_t)event->data_len + 1);
    if (!grown) return ESP_ERR_NO_MEM;
    response->data = grown;
    memcpy(response->data + response->length, event->data, (size_t)event->data_len);
    response->length += (size_t)event->data_len;
    response->data[response->length] = '\0';
    return ESP_OK;
}

static cJSON *only_response_records(cJSON *root) {
    if (!cJSON_IsObject(root)) return NULL;
    cJSON *records = NULL;
    bool accepted_seen = false;
    for (cJSON *field = root->child; field; field = field->next) {
        if (strcmp(field->string, "records") == 0) records = field;
        else if (strcmp(field->string, "accepted") == 0 && cJSON_IsNumber(field)) accepted_seen = true;
        else return NULL;
    }
    return records && accepted_seen && cJSON_IsArray(records) ? records : NULL;
}

static esp_err_t contact_peer(fm_protocol_t *protocol, const fm_config_t *config,
                              const fm_peer_t *peer) {
    char *request_body = NULL;
    size_t request_len = 0;
    esp_err_t err = fm_protocol_records_json(protocol, &request_body, &request_len);
    if (err != ESP_OK) return err;
    char url[FM_MAX_URL_BYTES + 16];
    int url_len = snprintf(url, sizeof(url), "%s/gossip", peer->url);
    if (url_len < 0 || (size_t)url_len >= sizeof(url)) { free(request_body); return ESP_ERR_INVALID_SIZE; }
    peer_response_t response = {0};
    esp_http_client_config_t client_config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = (int)config->contact_timeout_ms,
        .event_handler = response_event,
        .user_data = &response,
        .buffer_size = 1024,
        .buffer_size_tx = 1024,
    };
    esp_http_client_handle_t client = esp_http_client_init(&client_config);
    if (!client) { free(request_body); return ESP_ERR_NO_MEM; }
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, request_body, (int)request_len);
    err = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    free(request_body);
    if (response.overflow) err = ESP_ERR_INVALID_SIZE;
    if (err == ESP_OK && status != 200) err = ESP_FAIL;
    if (err == ESP_OK && response.length == 0) err = ESP_ERR_INVALID_RESPONSE;
    if (err == ESP_OK && memchr(response.data, '\0', response.length)) {
        err = ESP_ERR_INVALID_RESPONSE;
    }
    if (err == ESP_OK) {
        const char *end = NULL;
        cJSON *root = cJSON_ParseWithLengthOpts((char *)response.data, response.length + 1,
                                                &end, true);
        cJSON *records = only_response_records(root);
        if (!records || end != (char *)response.data + response.length) {
            err = ESP_ERR_INVALID_RESPONSE;
        }
        char *records_json = NULL;
        if (err == ESP_OK) records_json = cJSON_PrintUnformatted(records);
        if (err == ESP_OK && !records_json) err = ESP_ERR_NO_MEM;
        size_t accepted = 0;
        if (err == ESP_OK && strlen(records_json) > FM_BODY_MAX) err = ESP_ERR_INVALID_SIZE;
        if (err == ESP_OK) err = fm_protocol_ingest(protocol, (uint8_t *)records_json,
                                                     strlen(records_json), &accepted);
        free(records_json);
        cJSON_Delete(root);
    }
    free(response.data);
    return err;
}

static void peer_loop(void *argument) {
    (void)argument;
    for (;;) {
        for (size_t i = 0; i < server_config->peer_count; ++i) {
            esp_err_t err = contact_peer(server_protocol, server_config, &server_config->peers[i]);
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "peer %s contact failed: %s; retrying next round",
                         server_config->peers[i].id, esp_err_to_name(err));
            }
        }
        vTaskDelay(pdMS_TO_TICKS(server_config->contact_interval_ms));
    }
}

esp_err_t fm_http_start(fm_protocol_t *protocol, const fm_config_t *config) {
    server_protocol = protocol;
    server_config = config;
    httpd_config_t http_config = HTTPD_DEFAULT_CONFIG();
    http_config.server_port = 80;
    http_config.stack_size = 8192;
    http_config.max_uri_handlers = 4;
    http_config.recv_wait_timeout = 5;
    http_config.send_wait_timeout = 5;
    httpd_handle_t server = NULL;
    esp_err_t err = httpd_start(&server, &http_config);
    httpd_uri_t health = {.uri = "/health", .method = HTTP_GET, .handler = health_handler};
    httpd_uri_t gossip = {.uri = "/gossip", .method = HTTP_POST, .handler = gossip_handler};
    if (err == ESP_OK) err = httpd_register_uri_handler(server, &health);
    if (err == ESP_OK) err = httpd_register_uri_handler(server, &gossip);
    return err;
}

esp_err_t fm_peer_loop_start(fm_protocol_t *protocol, const fm_config_t *config) {
    server_protocol = protocol;
    server_config = config;
    return xTaskCreate(peer_loop, "fleet-peers", 8192, NULL, 5, NULL) == pdPASS
               ? ESP_OK : ESP_ERR_NO_MEM;
}
