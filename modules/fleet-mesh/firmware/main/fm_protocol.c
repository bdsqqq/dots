#include "fm_protocol.h"

#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sodium.h"

static const char *TAG = "fleet-protocol";
static const char *STATE_PARTITION = "fleet_state";
static const char *STATE_NAMESPACE = "mesh";
static const char *STATE_KEY = "snapshot";

typedef struct {
    char *data;
    size_t length;
    size_t capacity;
} fm_buffer_t;

typedef struct {
    cJSON *root;
    cJSON *header;
    cJSON *encryption;
    const char *id;
    const char *kind;
    const char *authority;
    const char *signature;
    const char *fleet;
    const char *to;
    const char *resource;
    const char *operation;
    const char *not_before;
    const char *expires_at;
    const char *ephemeral_public_key;
    const char *iv;
    const char *ciphertext;
    const char *auth_tag;
    fm_revision_t revision;
} fm_command_view_t;

typedef struct {
    cJSON *root;
    const char *id;
    const char *command_id;
    const char *node;
    const char *resource;
    const char *status;
    const char *reason;
    const char *recorded_at;
    const char *signature;
    fm_revision_t revision;
    fm_revision_t resulting_revision;
    bool resulting_revision_is_null;
} fm_receipt_view_t;

static bool valid_utf8(const uint8_t *text, size_t length) {
    for (size_t i = 0; i < length;) {
        uint8_t c = text[i++];
        if (c < 0x80) continue;
        unsigned continuation;
        uint32_t codepoint;
        if ((c & 0xe0) == 0xc0) { continuation = 1; codepoint = c & 0x1f; }
        else if ((c & 0xf0) == 0xe0) { continuation = 2; codepoint = c & 0x0f; }
        else if ((c & 0xf8) == 0xf0) { continuation = 3; codepoint = c & 0x07; }
        else return false;
        if (i + continuation > length) return false;
        for (unsigned j = 0; j < continuation; ++j) {
            uint8_t next = text[i++];
            if ((next & 0xc0) != 0x80) return false;
            codepoint = (codepoint << 6) | (next & 0x3f);
        }
        if ((continuation == 1 && codepoint < 0x80) ||
            (continuation == 2 && codepoint < 0x800) ||
            (continuation == 3 && codepoint < 0x10000) || codepoint > 0x10ffff ||
            (codepoint >= 0xd800 && codepoint <= 0xdfff)) return false;
    }
    return true;
}

static bool json_has_nul_escape(const uint8_t *text, size_t length) {
    bool in_string = false;
    for (size_t i = 0; i < length; ++i) {
        if (!in_string) {
            if (text[i] == '"') in_string = true;
            continue;
        }
        if (text[i] == '"') { in_string = false; continue; }
        if (text[i] != '\\' || i + 1 >= length) continue;
        if (text[i + 1] == 'u' && i + 5 < length &&
            text[i + 2] == '0' && text[i + 3] == '0' &&
            text[i + 4] == '0' && text[i + 5] == '0') return true;
        ++i;
    }
    return false;
}

static cJSON *last_field(const cJSON *object, const char *name) {
    cJSON *match = NULL;
    for (cJSON *child = object ? object->child : NULL; child; child = child->next) {
        if (child->string && strcmp(child->string, name) == 0) match = child;
    }
    return match;
}

static bool exact_object(const cJSON *object, const char *const *fields, size_t count) {
    if (!cJSON_IsObject(object)) return false;
    for (cJSON *child = object->child; child; child = child->next) {
        bool known = false;
        for (size_t i = 0; i < count; ++i) {
            if (child->string && strcmp(child->string, fields[i]) == 0) known = true;
        }
        if (!known) return false;
    }
    for (size_t i = 0; i < count; ++i) {
        if (!last_field(object, fields[i])) return false;
    }
    return true;
}

static bool bounded_string(const cJSON *value, size_t maximum) {
    return cJSON_IsString(value) && value->valuestring && strlen(value->valuestring) <= maximum;
}

static bool safe_integer(const cJSON *value, int64_t *output) {
    if (!cJSON_IsNumber(value) || !isfinite(value->valuedouble) ||
        floor(value->valuedouble) != value->valuedouble ||
        fabs(value->valuedouble) > 9007199254740991.0) {
        return false;
    }
    *output = (int64_t)value->valuedouble;
    return true;
}

static bool parse_revision(cJSON *value, fm_revision_t *revision) {
    static const char *const fields[] = {"epoch", "sequence"};
    return exact_object(value, fields, 2) &&
           safe_integer(last_field(value, "epoch"), &revision->epoch) &&
           safe_integer(last_field(value, "sequence"), &revision->sequence);
}

static bool strict_json_value(cJSON *value, unsigned depth) {
    if (!value || depth > 64) return false;
    if (cJSON_IsNull(value) || cJSON_IsBool(value) || cJSON_IsString(value)) return true;
    if (cJSON_IsNumber(value)) {
        int64_t ignored;
        return safe_integer(value, &ignored);
    }
    if (cJSON_IsArray(value) || cJSON_IsObject(value)) {
        for (cJSON *child = value->child; child; child = child->next) {
            if (!strict_json_value(child, depth + 1)) return false;
        }
        return true;
    }
    return false;
}

static bool nullable_bounded_string(cJSON *value, size_t maximum, const char **output) {
    if (cJSON_IsNull(value)) {
        *output = NULL;
        return true;
    }
    if (!bounded_string(value, maximum)) return false;
    *output = value->valuestring;
    return true;
}

static bool command_schema(cJSON *root, fm_command_view_t *view) {
    static const char *const fields[] = {
        "kind", "id", "header", "encryption", "authority", "signature",
    };
    static const char *const header_fields[] = {
        "version", "fleet", "to", "resource", "operation", "revision",
        "notBefore", "expiresAt",
    };
    static const char *const encryption_fields[] = {
        "ephemeralPublicKey", "iv", "ciphertext", "authTag",
    };
    memset(view, 0, sizeof(*view));
    if (!exact_object(root, fields, 6)) return false;
    cJSON *kind = last_field(root, "kind");
    cJSON *id = last_field(root, "id");
    cJSON *header = last_field(root, "header");
    cJSON *encryption = last_field(root, "encryption");
    cJSON *authority = last_field(root, "authority");
    cJSON *signature = last_field(root, "signature");
    if (!bounded_string(kind, 16) || strcmp(kind->valuestring, "command") != 0 ||
        !bounded_string(id, 64) || !exact_object(header, header_fields, 8) ||
        !exact_object(encryption, encryption_fields, 4) ||
        !bounded_string(authority, FM_MAX_ID_BYTES) ||
        !bounded_string(signature, FM_MAX_SIGNATURE_TEXT_BYTES)) {
        return false;
    }
    int64_t version;
    cJSON *fleet = last_field(header, "fleet");
    cJSON *to = last_field(header, "to");
    cJSON *resource = last_field(header, "resource");
    cJSON *operation = last_field(header, "operation");
    cJSON *ephemeral = last_field(encryption, "ephemeralPublicKey");
    cJSON *iv = last_field(encryption, "iv");
    cJSON *ciphertext = last_field(encryption, "ciphertext");
    cJSON *auth_tag = last_field(encryption, "authTag");
    if (!safe_integer(last_field(header, "version"), &version) || version != 1 ||
        !bounded_string(fleet, FM_MAX_ID_BYTES) || !bounded_string(to, FM_MAX_ID_BYTES) ||
        !bounded_string(resource, FM_MAX_RESOURCE_BYTES) || !bounded_string(operation, 16) ||
        strcmp(operation->valuestring, "set") != 0 ||
        !parse_revision(last_field(header, "revision"), &view->revision) ||
        !nullable_bounded_string(last_field(header, "notBefore"), FM_MAX_TIME_BYTES,
                                 &view->not_before) ||
        !nullable_bounded_string(last_field(header, "expiresAt"), FM_MAX_TIME_BYTES,
                                 &view->expires_at) ||
        !bounded_string(ephemeral, FM_MAX_PEM_BYTES) ||
        !bounded_string(iv, FM_BODY_MAX) || !bounded_string(ciphertext, FM_BODY_MAX) ||
        !bounded_string(auth_tag, FM_MAX_SIGNATURE_TEXT_BYTES)) {
        return false;
    }
    view->root = root;
    view->header = header;
    view->encryption = encryption;
    view->id = id->valuestring;
    view->kind = kind->valuestring;
    view->authority = authority->valuestring;
    view->signature = signature->valuestring;
    view->fleet = fleet->valuestring;
    view->to = to->valuestring;
    view->resource = resource->valuestring;
    view->operation = operation->valuestring;
    view->ephemeral_public_key = ephemeral->valuestring;
    view->iv = iv->valuestring;
    view->ciphertext = ciphertext->valuestring;
    view->auth_tag = auth_tag->valuestring;
    return true;
}

static bool receipt_schema(cJSON *root, fm_receipt_view_t *view) {
    static const char *const fields[] = {
        "kind", "id", "commandId", "node", "resource", "revision", "status",
        "reason", "resultingRevision", "recordedAt", "signature",
    };
    memset(view, 0, sizeof(*view));
    if (!exact_object(root, fields, 11)) return false;
    cJSON *kind = last_field(root, "kind");
    cJSON *id = last_field(root, "id");
    cJSON *command_id = last_field(root, "commandId");
    cJSON *node = last_field(root, "node");
    cJSON *resource = last_field(root, "resource");
    cJSON *status = last_field(root, "status");
    cJSON *reason = last_field(root, "reason");
    cJSON *resulting = last_field(root, "resultingRevision");
    cJSON *recorded_at = last_field(root, "recordedAt");
    cJSON *signature = last_field(root, "signature");
    if (!bounded_string(kind, 16) || strcmp(kind->valuestring, "receipt") != 0 ||
        !bounded_string(id, 64) || !bounded_string(command_id, 64) ||
        !bounded_string(node, FM_MAX_ID_BYTES) ||
        !bounded_string(resource, FM_MAX_RESOURCE_BYTES) ||
        !parse_revision(last_field(root, "revision"), &view->revision) ||
        !bounded_string(status, 16) ||
        (strcmp(status->valuestring, "applied") != 0 &&
         strcmp(status->valuestring, "rejected") != 0) ||
        !(cJSON_IsNull(reason) || (bounded_string(reason, 16) &&
          (strcmp(reason->valuestring, "stale") == 0 ||
           strcmp(reason->valuestring, "expired") == 0))) ||
        !bounded_string(recorded_at, FM_MAX_TIME_BYTES) ||
        !bounded_string(signature, FM_MAX_SIGNATURE_TEXT_BYTES)) {
        return false;
    }
    if (cJSON_IsNull(resulting)) {
        view->resulting_revision_is_null = true;
    } else if (!parse_revision(resulting, &view->resulting_revision)) {
        return false;
    }
    view->root = root;
    view->id = id->valuestring;
    view->command_id = command_id->valuestring;
    view->node = node->valuestring;
    view->resource = resource->valuestring;
    view->status = status->valuestring;
    view->reason = cJSON_IsNull(reason) ? NULL : reason->valuestring;
    view->recorded_at = recorded_at->valuestring;
    view->signature = signature->valuestring;
    return true;
}

static esp_err_t buffer_reserve(fm_buffer_t *buffer, size_t extra) {
    if (extra > FM_BODY_MAX || buffer->length > FM_BODY_MAX - extra) return ESP_ERR_INVALID_SIZE;
    size_t needed = buffer->length + extra + 1;
    if (needed <= buffer->capacity) return ESP_OK;
    size_t capacity = buffer->capacity ? buffer->capacity : 256;
    while (capacity < needed && capacity < FM_BODY_MAX + 1) capacity *= 2;
    if (capacity > FM_BODY_MAX + 1) capacity = FM_BODY_MAX + 1;
    if (capacity < needed) return ESP_ERR_INVALID_SIZE;
    char *grown = realloc(buffer->data, capacity);
    if (!grown) return ESP_ERR_NO_MEM;
    buffer->data = grown;
    buffer->capacity = capacity;
    return ESP_OK;
}

static esp_err_t append_bytes(fm_buffer_t *buffer, const char *text, size_t length) {
    esp_err_t err = buffer_reserve(buffer, length);
    if (err != ESP_OK) return err;
    memcpy(buffer->data + buffer->length, text, length);
    buffer->length += length;
    buffer->data[buffer->length] = '\0';
    return ESP_OK;
}

static esp_err_t append_text(fm_buffer_t *buffer, const char *text) {
    return append_bytes(buffer, text, strlen(text));
}

static esp_err_t append_json_string(fm_buffer_t *buffer, const char *text) {
    esp_err_t err = append_text(buffer, "\"");
    if (err != ESP_OK) return err;
    for (const unsigned char *cursor = (const unsigned char *)text; *cursor; ++cursor) {
        const char *escape = NULL;
        switch (*cursor) {
            case '\"': escape = "\\\""; break;
            case '\\': escape = "\\\\"; break;
            case '\b': escape = "\\b"; break;
            case '\f': escape = "\\f"; break;
            case '\n': escape = "\\n"; break;
            case '\r': escape = "\\r"; break;
            case '\t': escape = "\\t"; break;
            default: break;
        }
        if (escape) {
            err = append_text(buffer, escape);
        } else if (*cursor < 0x20) {
            char encoded[7];
            snprintf(encoded, sizeof(encoded), "\\u%04x", *cursor);
            err = append_text(buffer, encoded);
        } else {
            err = append_bytes(buffer, (const char *)cursor, 1);
        }
        if (err != ESP_OK) return err;
    }
    return append_text(buffer, "\"");
}

static esp_err_t append_revision(fm_buffer_t *buffer, fm_revision_t revision) {
    char text[96];
    int length = snprintf(text, sizeof(text), "{\"epoch\":%" PRId64
                          ",\"sequence\":%" PRId64 "}",
                          revision.epoch, revision.sequence);
    if (length < 0 || (size_t)length >= sizeof(text)) return ESP_FAIL;
    return append_bytes(buffer, text, (size_t)length);
}

#define APPEND_LITERAL(value) do { err = append_text(buffer, (value)); if (err != ESP_OK) return err; } while (0)
#define APPEND_STRING(value) do { err = append_json_string(buffer, (value)); if (err != ESP_OK) return err; } while (0)

static esp_err_t append_header(fm_buffer_t *buffer, const fm_command_view_t *command) {
    esp_err_t err;
    APPEND_LITERAL("{\"expiresAt\":");
    if (command->expires_at) APPEND_STRING(command->expires_at); else APPEND_LITERAL("null");
    APPEND_LITERAL(",\"fleet\":"); APPEND_STRING(command->fleet);
    APPEND_LITERAL(",\"notBefore\":");
    if (command->not_before) APPEND_STRING(command->not_before); else APPEND_LITERAL("null");
    APPEND_LITERAL(",\"operation\":"); APPEND_STRING(command->operation);
    APPEND_LITERAL(",\"resource\":"); APPEND_STRING(command->resource);
    APPEND_LITERAL(",\"revision\":");
    err = append_revision(buffer, command->revision); if (err != ESP_OK) return err;
    APPEND_LITERAL(",\"to\":"); APPEND_STRING(command->to);
    APPEND_LITERAL(",\"version\":1}");
    return ESP_OK;
}

static esp_err_t command_canonical(const fm_command_view_t *command, bool include_signature,
                                   fm_buffer_t *buffer) {
    esp_err_t err;
    APPEND_LITERAL("{\"authority\":"); APPEND_STRING(command->authority);
    APPEND_LITERAL(",\"encryption\":{\"authTag\":"); APPEND_STRING(command->auth_tag);
    APPEND_LITERAL(",\"ciphertext\":"); APPEND_STRING(command->ciphertext);
    APPEND_LITERAL(",\"ephemeralPublicKey\":");
    APPEND_STRING(command->ephemeral_public_key);
    APPEND_LITERAL(",\"iv\":"); APPEND_STRING(command->iv);
    APPEND_LITERAL("},\"header\":");
    err = append_header(buffer, command); if (err != ESP_OK) return err;
    APPEND_LITERAL(",\"kind\":\"command\"");
    if (include_signature) {
        APPEND_LITERAL(",\"signature\":"); APPEND_STRING(command->signature);
    }
    APPEND_LITERAL("}");
    return ESP_OK;
}

static esp_err_t receipt_canonical(const fm_receipt_view_t *receipt, bool include_signature,
                                   fm_buffer_t *buffer) {
    esp_err_t err;
    APPEND_LITERAL("{\"commandId\":"); APPEND_STRING(receipt->command_id);
    APPEND_LITERAL(",\"kind\":\"receipt\",\"node\":"); APPEND_STRING(receipt->node);
    APPEND_LITERAL(",\"reason\":");
    if (receipt->reason) APPEND_STRING(receipt->reason); else APPEND_LITERAL("null");
    APPEND_LITERAL(",\"recordedAt\":"); APPEND_STRING(receipt->recorded_at);
    APPEND_LITERAL(",\"resource\":"); APPEND_STRING(receipt->resource);
    APPEND_LITERAL(",\"resultingRevision\":");
    if (receipt->resulting_revision_is_null) APPEND_LITERAL("null");
    else { err = append_revision(buffer, receipt->resulting_revision); if (err != ESP_OK) return err; }
    APPEND_LITERAL(",\"revision\":");
    err = append_revision(buffer, receipt->revision); if (err != ESP_OK) return err;
    if (include_signature) {
        APPEND_LITERAL(",\"signature\":"); APPEND_STRING(receipt->signature);
    }
    APPEND_LITERAL(",\"status\":"); APPEND_STRING(receipt->status);
    APPEND_LITERAL("}");
    return ESP_OK;
}

#undef APPEND_LITERAL
#undef APPEND_STRING

static int compare_revision(fm_revision_t left, fm_revision_t right) {
    if (left.epoch != right.epoch) return left.epoch < right.epoch ? -1 : 1;
    if (left.sequence != right.sequence) return left.sequence < right.sequence ? -1 : 1;
    return 0;
}

static cJSON *find_record(const fm_protocol_t *protocol, const char *id) {
    for (size_t i = 0; i < protocol->record_count; ++i) {
        cJSON *record_id = last_field(protocol->records[i], "id");
        if (cJSON_IsString(record_id) && strcmp(record_id->valuestring, id) == 0) {
            return protocol->records[i];
        }
    }
    return NULL;
}

static fm_outcome_t *find_outcome(fm_protocol_t *protocol, const char *command_id) {
    for (size_t i = 0; i < protocol->outcome_count; ++i) {
        if (strcmp(protocol->outcomes[i].command_id, command_id) == 0) {
            return &protocol->outcomes[i];
        }
    }
    return NULL;
}

static fm_resource_state_t *find_resource(fm_protocol_t *protocol, const char *resource) {
    for (size_t i = 0; i < protocol->resource_count; ++i) {
        if (strcmp(protocol->resources[i].resource, resource) == 0) {
            return &protocol->resources[i];
        }
    }
    return NULL;
}

static bool valid_command(const fm_protocol_t *protocol, const fm_command_view_t *command) {
    if (strcmp(command->fleet, protocol->config->fleet) != 0 ||
        strcmp(command->authority, protocol->config->authority_id) != 0) {
        return false;
    }
    fm_buffer_t signed_bytes = {0};
    fm_buffer_t id_bytes = {0};
    char id[65];
    bool valid = command_canonical(command, false, &signed_bytes) == ESP_OK &&
                 fm_ed25519_verify(protocol->config->authority_public,
                                   (const uint8_t *)signed_bytes.data,
                                   signed_bytes.length, command->signature) &&
                 command_canonical(command, true, &id_bytes) == ESP_OK &&
                 fm_sha256_hex((const uint8_t *)id_bytes.data, id_bytes.length, id) == ESP_OK &&
                 strcmp(id, command->id) == 0;
    free(signed_bytes.data);
    free(id_bytes.data);
    return valid;
}

static bool valid_receipt(const fm_protocol_t *protocol, const fm_receipt_view_t *receipt) {
    const fm_public_identity_t *signer = fm_config_roster_find(protocol->config, receipt->node);
    cJSON *command_root = find_record(protocol, receipt->command_id);
    fm_command_view_t command;
    if (!signer || !command_root || !command_schema(command_root, &command) ||
        strcmp(receipt->node, command.to) != 0 ||
        strcmp(receipt->resource, command.resource) != 0 ||
        compare_revision(receipt->revision, command.revision) != 0) {
        return false;
    }
    fm_buffer_t signed_bytes = {0};
    fm_buffer_t id_bytes = {0};
    char id[65];
    bool valid = receipt_canonical(receipt, false, &signed_bytes) == ESP_OK &&
                 fm_ed25519_verify(signer->signing_public,
                                   (const uint8_t *)signed_bytes.data,
                                   signed_bytes.length, receipt->signature) &&
                 receipt_canonical(receipt, true, &id_bytes) == ESP_OK &&
                 fm_sha256_hex((const uint8_t *)id_bytes.data, id_bytes.length, id) == ESP_OK &&
                 strcmp(id, receipt->id) == 0;
    free(signed_bytes.data);
    free(id_bytes.data);
    return valid;
}

static cJSON *records_array(const fm_protocol_t *protocol) {
    cJSON *array = cJSON_CreateArray();
    if (!array) return NULL;
    for (size_t i = 0; i < protocol->record_count; ++i) {
        cJSON *copy = cJSON_Duplicate(protocol->records[i], true);
        if (!copy || !cJSON_AddItemToArray(array, copy)) {
            cJSON_Delete(copy);
            cJSON_Delete(array);
            return NULL;
        }
    }
    return array;
}

static bool state_fits_gossip_response(const fm_protocol_t *protocol) {
    cJSON *root = cJSON_CreateObject();
    cJSON *records = records_array(protocol);
    if (!root || !records || !cJSON_AddNumberToObject(root, "accepted", FM_MAX_RECORDS) ||
        !cJSON_AddItemToObject(root, "records", records)) {
        cJSON_Delete(root); cJSON_Delete(records); return false;
    }
    char *text = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    bool fits = text && strlen(text) <= FM_BODY_MAX;
    free(text);
    return fits;
}

static cJSON *snapshot_json(const fm_protocol_t *protocol) {
    cJSON *root = cJSON_CreateObject();
    cJSON *records = records_array(protocol);
    cJSON *resources = cJSON_CreateArray();
    cJSON *outcomes = cJSON_CreateArray();
    if (!root || !records || !resources || !outcomes) {
        cJSON_Delete(root); cJSON_Delete(records); cJSON_Delete(resources); cJSON_Delete(outcomes);
        return NULL;
    }
    if (!cJSON_AddNumberToObject(root, "version", 1) ||
        !cJSON_AddItemToObject(root, "records", records)) {
        cJSON_Delete(root); cJSON_Delete(records); cJSON_Delete(resources); cJSON_Delete(outcomes);
        return NULL;
    }
    records = NULL;
    if (!cJSON_AddItemToObject(root, "resources", resources)) {
        cJSON_Delete(root); cJSON_Delete(resources); cJSON_Delete(outcomes); return NULL;
    }
    resources = NULL;
    if (!cJSON_AddItemToObject(root, "outcomes", outcomes)) {
        cJSON_Delete(root); cJSON_Delete(outcomes); return NULL;
    }
    outcomes = NULL;
    cJSON *resource_array = last_field(root, "resources");
    cJSON *outcome_array = last_field(root, "outcomes");
    for (size_t i = 0; i < protocol->resource_count; ++i) {
        const fm_resource_state_t *state = &protocol->resources[i];
        char *value = NULL;
        if (fm_base64_encode(state->value_utf8, state->value_len, &value) != ESP_OK) {
            cJSON_Delete(root); return NULL;
        }
        cJSON *entry = cJSON_CreateObject();
        cJSON *revision = cJSON_CreateObject();
        bool ok = entry && revision &&
                  cJSON_AddNumberToObject(revision, "epoch", (double)state->revision.epoch) &&
                  cJSON_AddNumberToObject(revision, "sequence", (double)state->revision.sequence) &&
                  cJSON_AddStringToObject(entry, "resource", state->resource) &&
                  cJSON_AddItemToObject(entry, "revision", revision) &&
                  cJSON_AddStringToObject(entry, "commandId", state->command_id) &&
                  cJSON_AddStringToObject(entry, "valueUtf8", value) &&
                  cJSON_AddItemToArray(resource_array, entry);
        free(value);
        if (!ok) { cJSON_Delete(entry); cJSON_Delete(root); return NULL; }
    }
    for (size_t i = 0; i < protocol->outcome_count; ++i) {
        const fm_outcome_t *outcome = &protocol->outcomes[i];
        cJSON *entry = cJSON_CreateObject();
        if (!entry || !cJSON_AddStringToObject(entry, "commandId", outcome->command_id) ||
            !cJSON_AddStringToObject(entry, "receiptId", outcome->receipt_id) ||
            !cJSON_AddNumberToObject(entry, "executions", outcome->executions) ||
            !cJSON_AddItemToArray(outcome_array, entry)) {
            cJSON_Delete(entry); cJSON_Delete(root); return NULL;
        }
    }
    return root;
}

static esp_err_t persist_state(const fm_protocol_t *protocol) {
    cJSON *snapshot = snapshot_json(protocol);
    if (!snapshot) return ESP_ERR_NO_MEM;
    char *text = cJSON_PrintUnformatted(snapshot);
    cJSON_Delete(snapshot);
    if (!text) return ESP_ERR_NO_MEM;
    size_t length = strlen(text);
    if (length > FM_BODY_MAX) { free(text); return ESP_ERR_INVALID_SIZE; }
    nvs_handle_t handle = 0;
    esp_err_t err = nvs_open_from_partition(STATE_PARTITION, STATE_NAMESPACE,
                                            NVS_READWRITE, &handle);
    if (err == ESP_OK) err = nvs_set_blob(handle, STATE_KEY, text, length);
    if (err == ESP_OK) err = nvs_commit(handle);
    if (handle) nvs_close(handle);
    free(text);
    return err;
}

static void clear_state(fm_protocol_t *protocol) {
    for (size_t i = 0; i < protocol->record_count; ++i) cJSON_Delete(protocol->records[i]);
    for (size_t i = 0; i < protocol->resource_count; ++i) {
        free(protocol->resources[i].resource);
        if (protocol->resources[i].value_utf8) {
            sodium_memzero(protocol->resources[i].value_utf8,
                           protocol->resources[i].value_len);
            free(protocol->resources[i].value_utf8);
        }
    }
    memset(protocol->records, 0, sizeof(protocol->records));
    memset(protocol->resources, 0, sizeof(protocol->resources));
    memset(protocol->outcomes, 0, sizeof(protocol->outcomes));
    protocol->record_count = protocol->resource_count = protocol->outcome_count = 0;
}

static esp_err_t load_snapshot_value(fm_protocol_t *protocol, cJSON *root) {
    cJSON *version = last_field(root, "version");
    cJSON *records = last_field(root, "records");
    cJSON *resources = last_field(root, "resources");
    cJSON *outcomes = last_field(root, "outcomes");
    int64_t version_number;
    static const char *const snapshot_fields[] = {"version", "records", "resources", "outcomes"};
    static const char *const resource_fields[] = {"resource", "revision", "commandId", "valueUtf8"};
    static const char *const outcome_fields[] = {"commandId", "receiptId", "executions"};
    if (!exact_object(root, snapshot_fields, 4) ||
        !safe_integer(version, &version_number) || version_number != 1 ||
        !cJSON_IsArray(records) || !cJSON_IsArray(resources) || !cJSON_IsArray(outcomes) ||
        cJSON_GetArraySize(records) > FM_MAX_RECORDS ||
        cJSON_GetArraySize(resources) > FM_MAX_RESOURCES ||
        cJSON_GetArraySize(outcomes) > FM_MAX_OUTCOMES) {
        return ESP_ERR_INVALID_ARG;
    }
    clear_state(protocol);
    cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, records) {
        fm_command_view_t command;
        fm_receipt_view_t receipt;
        cJSON *kind = last_field(entry, "kind");
        if (!bounded_string(kind, 16) ||
            (strcmp(kind->valuestring, "command") == 0 && !command_schema(entry, &command)) ||
            (strcmp(kind->valuestring, "receipt") == 0 && !receipt_schema(entry, &receipt)) ||
            (strcmp(kind->valuestring, "command") != 0 &&
             strcmp(kind->valuestring, "receipt") != 0)) {
            clear_state(protocol); return ESP_ERR_INVALID_ARG;
        }
        cJSON *id = last_field(entry, "id");
        if (find_record(protocol, id->valuestring)) { clear_state(protocol); return ESP_ERR_INVALID_ARG; }
        protocol->records[protocol->record_count] = cJSON_Duplicate(entry, true);
        if (!protocol->records[protocol->record_count++]) { clear_state(protocol); return ESP_ERR_NO_MEM; }
    }
    cJSON_ArrayForEach(entry, resources) {
        fm_resource_state_t *state = &protocol->resources[protocol->resource_count];
        cJSON *resource = last_field(entry, "resource");
        cJSON *command_id = last_field(entry, "commandId");
        cJSON *value = last_field(entry, "valueUtf8");
        if (!exact_object(entry, resource_fields, 4) ||
            !bounded_string(resource, FM_MAX_RESOURCE_BYTES) || !bounded_string(command_id, 64) ||
            !bounded_string(value, FM_BODY_MAX) || find_resource(protocol, resource->valuestring) ||
            !parse_revision(last_field(entry, "revision"), &state->revision)) {
            clear_state(protocol); return ESP_ERR_INVALID_ARG;
        }
        state->resource = strdup(resource->valuestring);
        snprintf(state->command_id, sizeof(state->command_id), "%s", command_id->valuestring);
        esp_err_t err = fm_base64_decode_permissive(value->valuestring, &state->value_utf8,
                                                    &state->value_len);
        protocol->resource_count++;
        if (!state->resource || err != ESP_OK || state->value_len > FM_BODY_MAX ||
            memchr(state->value_utf8, '\0', state->value_len)) {
            clear_state(protocol); return err == ESP_OK ? ESP_ERR_NO_MEM : err;
        }
        char *encoded = NULL;
        err = fm_base64_encode(state->value_utf8, state->value_len, &encoded);
        bool canonical_value = err == ESP_OK && strcmp(encoded, value->valuestring) == 0;
        free(encoded);
        char *cleartext = malloc(state->value_len + 1);
        if (!cleartext) { clear_state(protocol); return ESP_ERR_NO_MEM; }
        memcpy(cleartext, state->value_utf8, state->value_len); cleartext[state->value_len] = '\0';
        const char *value_end = NULL;
        cJSON *parsed_value = cJSON_ParseWithLengthOpts(cleartext, state->value_len + 1,
                                                        &value_end, true);
        bool valid_value = canonical_value && parsed_value &&
                           value_end == cleartext + state->value_len &&
                           strict_json_value(parsed_value, 0);
        cJSON_Delete(parsed_value); free(cleartext);
        if (!valid_value) { clear_state(protocol); return ESP_ERR_INVALID_ARG; }
    }
    cJSON_ArrayForEach(entry, outcomes) {
        fm_outcome_t *outcome = &protocol->outcomes[protocol->outcome_count];
        cJSON *command_id = last_field(entry, "commandId");
        cJSON *receipt_id = last_field(entry, "receiptId");
        int64_t executions;
        if (!exact_object(entry, outcome_fields, 3) ||
            !bounded_string(command_id, 64) || !bounded_string(receipt_id, 64) ||
            find_outcome(protocol, command_id->valuestring) ||
            !safe_integer(last_field(entry, "executions"), &executions) ||
            executions < 0 || executions > 1) {
            clear_state(protocol); return ESP_ERR_INVALID_ARG;
        }
        snprintf(outcome->command_id, sizeof(outcome->command_id), "%s", command_id->valuestring);
        snprintf(outcome->receipt_id, sizeof(outcome->receipt_id), "%s", receipt_id->valuestring);
        outcome->executions = (uint32_t)executions;
        protocol->outcome_count++;
    }
    for (size_t i = 0; i < protocol->record_count; ++i) {
        cJSON *record = protocol->records[i];
        cJSON *kind = last_field(record, "kind");
        if (strcmp(kind->valuestring, "command") == 0) {
            fm_command_view_t command; command_schema(record, &command);
            if (!valid_command(protocol, &command)) { clear_state(protocol); return ESP_ERR_INVALID_CRC; }
        }
    }
    for (size_t i = 0; i < protocol->record_count; ++i) {
        cJSON *record = protocol->records[i];
        cJSON *kind = last_field(record, "kind");
        if (strcmp(kind->valuestring, "receipt") == 0) {
            fm_receipt_view_t receipt; receipt_schema(record, &receipt);
            if (!valid_receipt(protocol, &receipt)) { clear_state(protocol); return ESP_ERR_INVALID_CRC; }
        }
    }
    for (size_t i = 0; i < protocol->resource_count; ++i) {
        cJSON *command_root = find_record(protocol, protocol->resources[i].command_id);
        fm_command_view_t command;
        if (!command_root || !command_schema(command_root, &command) ||
            strcmp(command.resource, protocol->resources[i].resource) != 0 ||
            compare_revision(command.revision, protocol->resources[i].revision) != 0) {
            clear_state(protocol); return ESP_ERR_INVALID_ARG;
        }
    }
    for (size_t i = 0; i < protocol->outcome_count; ++i) {
        cJSON *command_root = find_record(protocol, protocol->outcomes[i].command_id);
        cJSON *receipt_root = find_record(protocol, protocol->outcomes[i].receipt_id);
        fm_command_view_t command; fm_receipt_view_t receipt;
        if (!command_root || !receipt_root || !command_schema(command_root, &command) ||
            !receipt_schema(receipt_root, &receipt) ||
            strcmp(receipt.command_id, command.id) != 0 ||
            protocol->outcomes[i].executions !=
                (strcmp(receipt.status, "applied") == 0 ? 1U : 0U)) {
            clear_state(protocol); return ESP_ERR_INVALID_ARG;
        }
    }
    if (!state_fits_gossip_response(protocol)) {
        clear_state(protocol); return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

static esp_err_t reload_state(fm_protocol_t *protocol) {
    nvs_handle_t handle = 0;
    esp_err_t err = nvs_open_from_partition(STATE_PARTITION, STATE_NAMESPACE,
                                            NVS_READONLY, &handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) { clear_state(protocol); return ESP_OK; }
    if (err != ESP_OK) return err;
    size_t length = 0;
    err = nvs_get_blob(handle, STATE_KEY, NULL, &length);
    if (err == ESP_ERR_NVS_NOT_FOUND) { nvs_close(handle); clear_state(protocol); return ESP_OK; }
    if (err != ESP_OK || length > FM_BODY_MAX) { nvs_close(handle); return ESP_ERR_INVALID_SIZE; }
    char *text = malloc(length + 1);
    if (!text) { nvs_close(handle); return ESP_ERR_NO_MEM; }
    err = nvs_get_blob(handle, STATE_KEY, text, &length);
    nvs_close(handle);
    if (err != ESP_OK) { free(text); return err; }
    text[length] = '\0';
    if (!valid_utf8((uint8_t *)text, length) || json_has_nul_escape((uint8_t *)text, length)) {
        free(text); return ESP_ERR_INVALID_ARG;
    }
    const char *end = NULL;
    cJSON *root = cJSON_ParseWithLengthOpts(text, length + 1, &end, true);
    if (!root || end != text + length) err = ESP_ERR_INVALID_ARG;
    else err = load_snapshot_value(protocol, root);
    cJSON_Delete(root);
    free(text);
    return err;
}

static bool parse_time(const char *text, int64_t *milliseconds) {
    int year, month, day, hour, minute, second, consumed = 0;
    int fraction = 0;
    if (sscanf(text, "%4d-%2d-%2dT%2d:%2d:%2d.%3dZ%n", &year, &month, &day,
               &hour, &minute, &second, &fraction, &consumed) != 7 ||
        text[consumed] != '\0' || month < 1 || month > 12 || day < 1 || day > 31 ||
        hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 ||
        fraction < 0 || fraction > 999) {
        return false;
    }
    int adjusted_year = year - (month <= 2);
    int era = (adjusted_year >= 0 ? adjusted_year : adjusted_year - 399) / 400;
    unsigned year_of_era = (unsigned)(adjusted_year - era * 400);
    unsigned adjusted_month = (unsigned)(month + (month > 2 ? -3 : 9));
    unsigned day_of_year = (153 * adjusted_month + 2) / 5 + (unsigned)day - 1;
    unsigned day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 +
                          day_of_year;
    int64_t days = (int64_t)era * 146097 + (int64_t)day_of_era - 719468;
    *milliseconds = (((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + fraction;
    return true;
}

static int64_t milliseconds(const struct timeval *now) {
    return (int64_t)now->tv_sec * 1000 + now->tv_usec / 1000;
}

static bool iso8601(const struct timeval *now, char output[25]) {
    struct tm utc;
    if (!gmtime_r(&now->tv_sec, &utc) ||
        strftime(output, 20, "%Y-%m-%dT%H:%M:%S", &utc) != 19) {
        return false;
    }
    unsigned milliseconds = (unsigned)(now->tv_usec / 1000) % 1000;
    output[19] = '.';
    output[20] = (char)('0' + milliseconds / 100);
    output[21] = (char)('0' + milliseconds / 10 % 10);
    output[22] = (char)('0' + milliseconds % 10);
    output[23] = 'Z';
    output[24] = '\0';
    return true;
}

static esp_err_t decrypt_command(const fm_protocol_t *protocol,
                                 const fm_command_view_t *command,
                                 uint8_t **plaintext, size_t *plaintext_len) {
    uint8_t ephemeral[32], shared[32], key[32];
    uint8_t *iv = NULL, *ciphertext = NULL, *tag = NULL;
    size_t iv_len = 0, ciphertext_len = 0, tag_len = 0;
    fm_buffer_t aad = {0};
    esp_err_t err = fm_parse_x25519_public_pem(command->ephemeral_public_key, ephemeral);
    if (err == ESP_OK) err = fm_x25519_shared(protocol->config->encryption_private,
                                              ephemeral, shared);
    if (err == ESP_OK) err = append_header(&aad, command);
    static const uint8_t salt[] = "fleet-mesh-v1";
    if (err == ESP_OK) err = fm_hkdf_sha256(shared, sizeof(shared), salt, sizeof(salt) - 1,
                                            (const uint8_t *)aad.data, aad.length,
                                            key, sizeof(key));
    if (err == ESP_OK) err = fm_base64_decode_permissive(command->iv, &iv, &iv_len);
    if (err == ESP_OK) err = fm_base64_decode_permissive(command->ciphertext, &ciphertext,
                                                         &ciphertext_len);
    if (err == ESP_OK) err = fm_base64_decode_permissive(command->auth_tag, &tag, &tag_len);
    uint8_t *cleartext = NULL;
    if (err == ESP_OK && (iv_len == 0 || tag_len != FM_AES_GCM_TAG_BYTES ||
                          ciphertext_len > FM_BODY_MAX - 1)) err = ESP_ERR_INVALID_SIZE;
    if (err == ESP_OK) {
        cleartext = malloc(ciphertext_len + 1);
        if (!cleartext) err = ESP_ERR_NO_MEM;
    }
    if (err == ESP_OK) {
        err = fm_aes256_gcm_decrypt(key, iv, iv_len, (const uint8_t *)aad.data, aad.length,
                                    ciphertext, ciphertext_len, tag, cleartext);
    }
    if (err == ESP_OK) {
        cleartext[ciphertext_len] = '\0';
        if (memchr(cleartext, '\0', ciphertext_len)) err = ESP_ERR_INVALID_ARG;
    }
    if (err == ESP_OK && (!valid_utf8(cleartext, ciphertext_len) ||
                          json_has_nul_escape(cleartext, ciphertext_len))) {
        err = ESP_ERR_INVALID_ARG;
    }
    if (err == ESP_OK) {
        const char *end = NULL;
        cJSON *value = cJSON_ParseWithLengthOpts((char *)cleartext, ciphertext_len + 1,
                                                 &end, true);
        if (!value || end != (char *)cleartext + ciphertext_len ||
            !strict_json_value(value, 0)) err = ESP_ERR_INVALID_ARG;
        cJSON_Delete(value);
    }
    sodium_memzero(shared, sizeof(shared)); sodium_memzero(key, sizeof(key));
    free(iv); free(ciphertext); free(tag); free(aad.data);
    if (err != ESP_OK) { free(cleartext); return err; }
    *plaintext = cleartext;
    *plaintext_len = ciphertext_len;
    return ESP_OK;
}

static esp_err_t create_receipt(fm_protocol_t *protocol, const fm_command_view_t *command,
                                 const char *status, const char *reason,
                                 const fm_revision_t *resulting, uint32_t executions,
                                 const struct timeval *now) {
    if (protocol->record_count >= FM_MAX_RECORDS ||
        protocol->outcome_count >= FM_MAX_OUTCOMES) return ESP_ERR_NO_MEM;
    char recorded_at[25];
    if (!iso8601(now, recorded_at)) return ESP_ERR_INVALID_STATE;
    fm_receipt_view_t receipt = {
        .command_id = command->id, .node = protocol->config->identity_id,
        .resource = command->resource, .status = status, .reason = reason,
        .recorded_at = recorded_at, .revision = command->revision,
        .resulting_revision_is_null = resulting == NULL,
    };
    if (resulting) receipt.resulting_revision = *resulting;
    fm_buffer_t signed_bytes = {0};
    esp_err_t err = receipt_canonical(&receipt, false, &signed_bytes);
    char *signature = NULL;
    if (err == ESP_OK) err = fm_ed25519_sign(protocol->config->signing_seed,
                                             (const uint8_t *)signed_bytes.data,
                                             signed_bytes.length, &signature);
    receipt.signature = signature;
    fm_buffer_t id_bytes = {0};
    char id[65];
    if (err == ESP_OK) err = receipt_canonical(&receipt, true, &id_bytes);
    if (err == ESP_OK) err = fm_sha256_hex((const uint8_t *)id_bytes.data,
                                           id_bytes.length, id);
    cJSON *root = NULL;
    cJSON *revision = NULL;
    cJSON *result_revision = NULL;
    if (err == ESP_OK) {
        root = cJSON_CreateObject(); revision = cJSON_CreateObject();
        if (resulting) result_revision = cJSON_CreateObject();
        bool ok = root && revision && cJSON_AddStringToObject(root, "kind", "receipt") &&
                  cJSON_AddStringToObject(root, "commandId", command->id) &&
                  cJSON_AddStringToObject(root, "node", protocol->config->identity_id) &&
                  cJSON_AddStringToObject(root, "resource", command->resource) &&
                  cJSON_AddNumberToObject(revision, "epoch", (double)command->revision.epoch) &&
                  cJSON_AddNumberToObject(revision, "sequence", (double)command->revision.sequence) &&
                  cJSON_AddItemToObject(root, "revision", revision) &&
                  cJSON_AddStringToObject(root, "status", status) &&
                  (reason ? cJSON_AddStringToObject(root, "reason", reason)
                          : cJSON_AddNullToObject(root, "reason"));
        if (ok && resulting) {
            ok = result_revision &&
                 cJSON_AddNumberToObject(result_revision, "epoch", (double)resulting->epoch) &&
                 cJSON_AddNumberToObject(result_revision, "sequence", (double)resulting->sequence) &&
                 cJSON_AddItemToObject(root, "resultingRevision", result_revision);
        } else if (ok) {
            ok = cJSON_AddNullToObject(root, "resultingRevision") != NULL;
        }
        ok = ok && cJSON_AddStringToObject(root, "recordedAt", recorded_at) &&
                  cJSON_AddStringToObject(root, "signature", signature) &&
                  cJSON_AddStringToObject(root, "id", id);
        if (!ok) err = ESP_ERR_NO_MEM;
    }
    if (err == ESP_OK) {
        protocol->records[protocol->record_count++] = root;
        fm_outcome_t *outcome = &protocol->outcomes[protocol->outcome_count++];
        snprintf(outcome->command_id, sizeof(outcome->command_id), "%s", command->id);
        snprintf(outcome->receipt_id, sizeof(outcome->receipt_id), "%s", id);
        outcome->executions = executions;
        root = NULL;
    }
    cJSON_Delete(root); free(signature); free(signed_bytes.data); free(id_bytes.data);
    return err;
}

static esp_err_t process_command(fm_protocol_t *protocol, cJSON *root) {
    fm_command_view_t command;
    if (!command_schema(root, &command) || strcmp(command.to, protocol->config->identity_id) != 0 ||
        find_outcome(protocol, command.id)) return ESP_OK;
    struct timeval now;
    if (!fm_clock_now(protocol->clock, &now)) return ESP_OK;
    int64_t current_time = milliseconds(&now), boundary;
    if (command.not_before && parse_time(command.not_before, &boundary) && current_time < boundary) {
        return ESP_OK;
    }
    if (command.expires_at && parse_time(command.expires_at, &boundary) && current_time >= boundary) {
        return create_receipt(protocol, &command, "rejected", "expired", NULL, 0, &now);
    }
    fm_resource_state_t *state = find_resource(protocol, command.resource);
    if (state && compare_revision(command.revision, state->revision) <= 0) {
        return create_receipt(protocol, &command, "rejected", "stale", &state->revision, 0,
                              &now);
    }
    uint8_t *plaintext = NULL;
    size_t plaintext_len = 0;
    esp_err_t err = decrypt_command(protocol, &command, &plaintext, &plaintext_len);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "recipient command %.64s cannot be decrypted or decoded", command.id);
        return ESP_OK; /* Invalid recipient commands remain relayable but are never receipted. */
    }
    if (!state) {
        if (protocol->resource_count >= FM_MAX_RESOURCES) { free(plaintext); return ESP_ERR_NO_MEM; }
        state = &protocol->resources[protocol->resource_count++];
        state->resource = strdup(command.resource);
        if (!state->resource) { free(plaintext); return ESP_ERR_NO_MEM; }
    } else {
        sodium_memzero(state->value_utf8, state->value_len);
        free(state->value_utf8);
    }
    state->revision = command.revision;
    snprintf(state->command_id, sizeof(state->command_id), "%s", command.id);
    state->value_utf8 = plaintext;
    state->value_len = plaintext_len;
    return create_receipt(protocol, &command, "applied", NULL, &command.revision, 1, &now);
}

esp_err_t fm_protocol_init(fm_protocol_t *protocol, const fm_config_t *config,
                           const fm_clock_t *clock) {
    memset(protocol, 0, sizeof(*protocol));
    protocol->config = config;
    protocol->clock = clock;
    protocol->lock = xSemaphoreCreateMutex();
    if (!protocol->lock) return ESP_ERR_NO_MEM;
    const esp_partition_t *partition = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, STATE_PARTITION);
    if (!partition || partition->address != FM_STATE_PARTITION_OFFSET ||
        partition->size != FM_STATE_PARTITION_SIZE) return ESP_ERR_NOT_FOUND;
    esp_err_t err = nvs_flash_init_partition(STATE_PARTITION);
    if (err != ESP_OK) return err;
    err = reload_state(protocol);
    if (err != ESP_OK) return err; /* Corrupt state fails closed; it is never auto-erased. */
    if (protocol->record_count == 0) return persist_state(protocol);
    return ESP_OK;
}

void fm_protocol_deinit(fm_protocol_t *protocol) {
    if (protocol->lock) xSemaphoreTake((SemaphoreHandle_t)protocol->lock, portMAX_DELAY);
    clear_state(protocol);
    if (protocol->lock) {
        xSemaphoreGive((SemaphoreHandle_t)protocol->lock);
        vSemaphoreDelete((SemaphoreHandle_t)protocol->lock);
    }
    memset(protocol, 0, sizeof(*protocol));
}

static esp_err_t process_pending_locked(fm_protocol_t *protocol, bool *changed) {
    /* Highest revisions run first, matching the reference model's stale receipts. */
    bool attempted[FM_MAX_RECORDS] = {0};
    for (;;) {
        size_t best_index = FM_MAX_RECORDS;
        fm_revision_t best_revision = {0};
        for (size_t i = 0; i < protocol->record_count; ++i) {
            fm_command_view_t command;
            if (!attempted[i] && command_schema(protocol->records[i], &command) &&
                strcmp(command.to, protocol->config->identity_id) == 0 &&
                !find_outcome(protocol, command.id) &&
                (best_index == FM_MAX_RECORDS ||
                 compare_revision(command.revision, best_revision) > 0)) {
                best_index = i;
                best_revision = command.revision;
            }
        }
        if (best_index == FM_MAX_RECORDS) return ESP_OK;
        attempted[best_index] = true;
        size_t outcomes_before = protocol->outcome_count;
        esp_err_t err = process_command(protocol, protocol->records[best_index]);
        if (err != ESP_OK) return err;
        if (protocol->outcome_count != outcomes_before) *changed = true;
    }
}

static void rollback(fm_protocol_t *protocol) {
    esp_err_t reload_err = reload_state(protocol);
    if (reload_err != ESP_OK) {
        ESP_LOGE(TAG, "state rollback failed: %s", esp_err_to_name(reload_err));
        /* Never expose a signed outcome that the durable snapshot cannot reproduce. */
        abort();
    }
}

static esp_err_t persist_changes(fm_protocol_t *protocol, bool changed) {
    esp_err_t err = ESP_OK;
    if (changed && !state_fits_gossip_response(protocol)) err = ESP_ERR_INVALID_SIZE;
    if (err == ESP_OK && changed) err = persist_state(protocol);
    return err;
}

esp_err_t fm_protocol_process_pending(fm_protocol_t *protocol) {
    xSemaphoreTake((SemaphoreHandle_t)protocol->lock, portMAX_DELAY);
    bool changed = false;
    esp_err_t err = process_pending_locked(protocol, &changed);
    if (err == ESP_OK) err = persist_changes(protocol, changed);
    if (err != ESP_OK) rollback(protocol);
    xSemaphoreGive((SemaphoreHandle_t)protocol->lock);
    return err;
}

esp_err_t fm_protocol_ingest(fm_protocol_t *protocol, const uint8_t *json, size_t json_len,
                             size_t *accepted) {
    *accepted = 0;
    if (json_len == 0 || json_len > FM_BODY_MAX || !valid_utf8(json, json_len) ||
        memchr(json, '\0', json_len) ||
        json_has_nul_escape(json, json_len)) {
        return ESP_ERR_INVALID_SIZE;
    }
    char *text = malloc(json_len + 1);
    if (!text) return ESP_ERR_NO_MEM;
    memcpy(text, json, json_len); text[json_len] = '\0';
    const char *end = NULL;
    cJSON *array = cJSON_ParseWithLengthOpts(text, json_len + 1, &end, true);
    bool parsed = array && end == text + json_len && cJSON_IsArray(array);
    free(text);
    if (!parsed) { cJSON_Delete(array); return ESP_ERR_INVALID_ARG; }
    cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, array) {
        cJSON *kind = last_field(entry, "kind");
        fm_command_view_t command;
        fm_receipt_view_t receipt;
        if (!bounded_string(kind, 16) ||
            (strcmp(kind->valuestring, "command") == 0 && !command_schema(entry, &command)) ||
            (strcmp(kind->valuestring, "receipt") == 0 && !receipt_schema(entry, &receipt)) ||
            (strcmp(kind->valuestring, "command") != 0 &&
             strcmp(kind->valuestring, "receipt") != 0)) {
            cJSON_Delete(array); return ESP_ERR_INVALID_ARG;
        }
    }
    xSemaphoreTake((SemaphoreHandle_t)protocol->lock, portMAX_DELAY);
    esp_err_t err = ESP_OK;
    bool changed = false;
    /* Two passes preserve the v1 command-before-receipt relation check. */
    for (unsigned pass = 0; pass < 2 && err == ESP_OK; ++pass) {
        cJSON_ArrayForEach(entry, array) {
            cJSON *kind = last_field(entry, "kind");
            bool is_command = strcmp(kind->valuestring, "command") == 0;
            if (is_command != (pass == 0)) continue;
            const char *id = last_field(entry, "id")->valuestring;
            if (find_record(protocol, id)) continue;
            bool valid;
            if (is_command) {
                fm_command_view_t command; command_schema(entry, &command);
                valid = valid_command(protocol, &command);
            } else {
                fm_receipt_view_t receipt; receipt_schema(entry, &receipt);
                valid = valid_receipt(protocol, &receipt);
            }
            if (!valid) continue;
            if (protocol->record_count >= FM_MAX_RECORDS) { err = ESP_ERR_NO_MEM; break; }
            cJSON *copy = cJSON_Duplicate(entry, true);
            if (!copy) { err = ESP_ERR_NO_MEM; break; }
            protocol->records[protocol->record_count++] = copy;
            (*accepted)++; changed = true;
        }
    }
    if (err == ESP_OK) {
        err = process_pending_locked(protocol, &changed);
    }
    if (err == ESP_OK) err = persist_changes(protocol, changed);
    if (err != ESP_OK) {
        rollback(protocol);
        *accepted = 0;
    }
    xSemaphoreGive((SemaphoreHandle_t)protocol->lock);
    cJSON_Delete(array);
    return err;
}

static esp_err_t print_bounded(cJSON *value, char **json, size_t *json_len) {
    char *text = cJSON_PrintUnformatted(value);
    if (!text) return ESP_ERR_NO_MEM;
    size_t length = strlen(text);
    if (length > FM_BODY_MAX) { free(text); return ESP_ERR_INVALID_SIZE; }
    *json = text; *json_len = length;
    return ESP_OK;
}

esp_err_t fm_protocol_records_json(fm_protocol_t *protocol, char **json, size_t *json_len) {
    xSemaphoreTake((SemaphoreHandle_t)protocol->lock, portMAX_DELAY);
    cJSON *array = records_array(protocol);
    esp_err_t err = array ? print_bounded(array, json, json_len) : ESP_ERR_NO_MEM;
    cJSON_Delete(array);
    xSemaphoreGive((SemaphoreHandle_t)protocol->lock);
    return err;
}

esp_err_t fm_protocol_gossip_response(fm_protocol_t *protocol, size_t accepted, char **json,
                                      size_t *json_len) {
    xSemaphoreTake((SemaphoreHandle_t)protocol->lock, portMAX_DELAY);
    cJSON *root = cJSON_CreateObject();
    cJSON *records = records_array(protocol);
    if (!root || !records || !cJSON_AddNumberToObject(root, "accepted", (double)accepted) ||
        !cJSON_AddItemToObject(root, "records", records)) {
        cJSON_Delete(root); cJSON_Delete(records);
        xSemaphoreGive((SemaphoreHandle_t)protocol->lock);
        return ESP_ERR_NO_MEM;
    }
    esp_err_t err = print_bounded(root, json, json_len);
    cJSON_Delete(root);
    xSemaphoreGive((SemaphoreHandle_t)protocol->lock);
    return err;
}

/* Test-only keys and bytes are copied from ../v1-conformance.json. */
esp_err_t fm_protocol_self_test(void) {
    static const char command_json[] =
        "{\"kind\":\"command\",\"header\":{\"version\":1,\"fleet\":\"home\","
        "\"to\":\"fixture-node\",\"resource\":\"fixture:value\",\"operation\":\"set\","
        "\"revision\":{\"epoch\":1,\"sequence\":1},\"notBefore\":null,\"expiresAt\":null},"
        "\"encryption\":{\"ephemeralPublicKey\":\"-----BEGIN PUBLIC KEY-----\\n"
        "MCowBQYDK2VuAyEAXsgIBHCQoUIR0iFFXHvYwLw01FaaglYpv2hrWbSOHjE=\\n"
        "-----END PUBLIC KEY-----\\n\",\"iv\":\"Q1PnOKzUhpdNa9pn\","
        "\"ciphertext\":\"npmV7GEMrwU7qj/nJk7H8WXr11QIDlAR3mc=\","
        "\"authTag\":\"ZMIXt1890QvTJ0DFHpTpxQ==\"},\"authority\":\"fixture-authority\","
        "\"signature\":\"A6furaAMo1TspHPBRo7xQtKRWQKzOHj1eaicNhNM16oYUP59Nc4nfWdSIN1qB4Vp7Jxd5OjzdGEPy1bVOdJLAA==\","
        "\"id\":\"e0bb33698d9141c727a049d0c7b576092e7959f48dee9fce99909c5211010832\"}";
    static const char expected_signed[] =
        "{\"authority\":\"fixture-authority\",\"encryption\":{\"authTag\":\"ZMIXt1890QvTJ0DFHpTpxQ==\","
        "\"ciphertext\":\"npmV7GEMrwU7qj/nJk7H8WXr11QIDlAR3mc=\",\"ephemeralPublicKey\":"
        "\"-----BEGIN PUBLIC KEY-----\\nMCowBQYDK2VuAyEAXsgIBHCQoUIR0iFFXHvYwLw01FaaglYpv2hrWbSOHjE=\\n"
        "-----END PUBLIC KEY-----\\n\",\"iv\":\"Q1PnOKzUhpdNa9pn\"},\"header\":{\"expiresAt\":null,"
        "\"fleet\":\"home\",\"notBefore\":null,\"operation\":\"set\",\"resource\":\"fixture:value\","
        "\"revision\":{\"epoch\":1,\"sequence\":1},\"to\":\"fixture-node\",\"version\":1},\"kind\":\"command\"}";
    static const uint8_t authority_public[32] = {
        0xf6,0xa5,0x5f,0xaf,0x64,0x57,0x23,0x4f,0xde,0xd3,0x71,0xe3,0xff,0x62,0x1e,0xe6,
        0x37,0xf9,0x85,0x21,0x2a,0xe3,0xb5,0xb2,0x6d,0x6f,0xe0,0x93,0x76,0x83,0x6e,0x59,
    };
    static const uint8_t signing_seed[32] = {
        0xfb,0x53,0xd5,0xf6,0xb7,0x1f,0x94,0xa2,0xd9,0xb4,0xfe,0x92,0xd7,0x64,0xed,0xa0,
        0xe2,0x87,0x67,0xc6,0x00,0xfe,0xff,0xcc,0x93,0xa7,0x42,0x6d,0x7b,0x5d,0x03,0xf5,
    };
    static const uint8_t encryption_private[32] = {
        0xa0,0x73,0x25,0xc4,0x86,0x1d,0x95,0x26,0xdc,0x5a,0x97,0xcb,0xbf,0x70,0x39,0xe4,
        0x6b,0x79,0x4e,0xf1,0xb1,0x0a,0x97,0x57,0x90,0x7e,0x8c,0xbf,0xef,0x72,0xb4,0x49,
    };
    static const char expected_id[] = "e0bb33698d9141c727a049d0c7b576092e7959f48dee9fce99909c5211010832";
    static const char expected_receipt_signature[] =
        "jrPdN3EXO+6BrrBBMrj85K9kZpzohYY9pPepCZ6FlmNAz6VENUyNM/7YvcoW/lgJWIxASXxtiMGKhZ98faafDQ==";
    static const char expected_receipt_id[] =
        "e1aaf7e65212a718aa565c2ab237aacfc469543f9f45cf6ff6c300c36d9159e1";

    cJSON *root = cJSON_Parse(command_json);
    fm_command_view_t command;
    if (!root || !command_schema(root, &command)) { cJSON_Delete(root); return ESP_FAIL; }
    fm_buffer_t canonical = {0}, id_bytes = {0};
    char id[65];
    esp_err_t err = command_canonical(&command, false, &canonical);
    if (err == ESP_OK && (canonical.length != strlen(expected_signed) ||
                          memcmp(canonical.data, expected_signed, canonical.length) != 0)) err = ESP_FAIL;
    if (err == ESP_OK && !fm_ed25519_verify(authority_public, (uint8_t *)canonical.data,
                                             canonical.length, command.signature)) err = ESP_FAIL;
    if (err == ESP_OK) err = command_canonical(&command, true, &id_bytes);
    if (err == ESP_OK) err = fm_sha256_hex((uint8_t *)id_bytes.data, id_bytes.length, id);
    if (err == ESP_OK && strcmp(id, expected_id) != 0) err = ESP_FAIL;

    fm_config_t *config = calloc(1, sizeof(*config));
    fm_protocol_t *protocol = calloc(1, sizeof(*protocol));
    if (!config || !protocol) err = ESP_ERR_NO_MEM;
    if (err == ESP_OK) {
        memcpy(config->encryption_private, encryption_private, sizeof(encryption_private));
        protocol->config = config;
    }
    uint8_t *plaintext = NULL;
    size_t plaintext_len = 0;
    if (err == ESP_OK) err = decrypt_command(protocol, &command, &plaintext, &plaintext_len);
    if (err == ESP_OK && (plaintext_len != strlen("{\"count\":7,\"enabled\":true}") ||
                          memcmp(plaintext, "{\"count\":7,\"enabled\":true}", plaintext_len) != 0)) {
        err = ESP_FAIL;
    }

    fm_receipt_view_t receipt = {
        .command_id = expected_id, .node = "fixture-node", .resource = "fixture:value",
        .status = "applied", .reason = NULL, .recorded_at = "2026-09-01T12:00:00.000Z",
        .revision = {.epoch = 1, .sequence = 1},
        .resulting_revision = {.epoch = 1, .sequence = 1},
        .resulting_revision_is_null = false,
    };
    fm_buffer_t receipt_signed = {0}, receipt_id_bytes = {0};
    char *receipt_signature = NULL;
    if (err == ESP_OK) err = receipt_canonical(&receipt, false, &receipt_signed);
    if (err == ESP_OK) err = fm_ed25519_sign(signing_seed, (uint8_t *)receipt_signed.data,
                                              receipt_signed.length, &receipt_signature);
    if (err == ESP_OK && strcmp(receipt_signature, expected_receipt_signature) != 0) err = ESP_FAIL;
    receipt.signature = receipt_signature;
    if (err == ESP_OK) err = receipt_canonical(&receipt, true, &receipt_id_bytes);
    if (err == ESP_OK) err = fm_sha256_hex((uint8_t *)receipt_id_bytes.data,
                                           receipt_id_bytes.length, id);
    if (err == ESP_OK && strcmp(id, expected_receipt_id) != 0) err = ESP_FAIL;

    cJSON_Delete(root); free(canonical.data); free(id_bytes.data); free(plaintext);
    free(receipt_signed.data); free(receipt_id_bytes.data); free(receipt_signature);
    if (config) sodium_memzero(config, sizeof(*config));
    free(protocol); free(config);
    return err;
}
