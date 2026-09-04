#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "fm_clock.h"
#include "fm_config.h"
#include "fm_crypto.h"
#include "fm_http.h"
#include "fm_openeth.h"
#include "fm_protocol.h"

static const char *TAG = "fleet-app";
static fm_clock_t wall_clock;
static fm_config_t config;
static fm_protocol_t protocol;

void app_main(void) {
    /* Startup invariants fail closed; peer contacts are deliberately recoverable. */
    ESP_LOGI(TAG, "checking cryptographic runtime");
    ESP_ERROR_CHECK(fm_crypto_init());
    ESP_LOGI(TAG, "checking protocol conformance");
    ESP_ERROR_CHECK(fm_protocol_self_test());
    ESP_LOGI(TAG, "loading provisioned configuration");
    ESP_ERROR_CHECK(fm_config_load(&config));
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(fm_protocol_init(&protocol, &config, &wall_clock));
    ESP_ERROR_CHECK(fm_openeth_start());
    ESP_ERROR_CHECK(fm_clock_start(&wall_clock));
    esp_err_t ip_status = fm_openeth_wait_for_ip(30000);
    if (ip_status != ESP_OK) {
        ESP_LOGW(TAG, "DHCP is not ready: %s; peer loop will retry", esp_err_to_name(ip_status));
    }
    ESP_ERROR_CHECK(fm_http_start(&protocol, &config));
    ESP_ERROR_CHECK(fm_peer_loop_start(&protocol, &config));
    ESP_LOGI(TAG, "node %s listening on plain HTTP port 80", config.identity_id);
}
