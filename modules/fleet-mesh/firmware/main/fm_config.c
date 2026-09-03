#include "fm_config.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_log.h"
#include "esp_partition.h"
#include "sodium.h"

static const char *TAG = "fleet-config";

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

static bool exact_object(const cJSON *object, const char *const *fields, size_t field_count) {
    if (!cJSON_IsObject(object)) return false;
    for (cJSON *child = object->child; child; child = child->next) {
        bool known = false;
        for (size_t i = 0; i < field_count; ++i) {
            if (child->string && strcmp(child->string, fields[i]) == 0) known = true;
        }
        if (!known) return false;
    }
    for (size_t i = 0; i < field_count; ++i) {
        if (!last_field(object, fields[i])) return false;
    }
    return true;
}

static bool safe_integer(const cJSON *value, double minimum, double maximum) {
    return cJSON_IsNumber(value) && isfinite(value->valuedouble) &&
           floor(value->valuedouble) == value->valuedouble &&
           value->valuedouble >= minimum && value->valuedouble <= maximum &&
           fabs(value->valuedouble) <= 9007199254740991.0;
}

static esp_err_t copy_string(const cJSON *object, const char *field, size_t maximum,
                             char **output) {
    cJSON *value = last_field(object, field);
    if (!cJSON_IsString(value) || !value->valuestring) return ESP_ERR_INVALID_ARG;
    size_t length = strlen(value->valuestring);
    if (length > maximum) return ESP_ERR_INVALID_SIZE;
    *output = strdup(value->valuestring);
    return *output ? ESP_OK : ESP_ERR_NO_MEM;
}

static bool valid_utf8(const uint8_t *text, size_t length) {
    for (size_t i = 0; i < length;) {
        uint8_t c = text[i++];
        if (c < 0x80) continue;
        unsigned continuation;
        uint32_t codepoint;
        if ((c & 0xe0) == 0xc0) {
            continuation = 1;
            codepoint = c & 0x1f;
        } else if ((c & 0xf0) == 0xe0) {
            continuation = 2;
            codepoint = c & 0x0f;
        } else if ((c & 0xf8) == 0xf0) {
            continuation = 3;
            codepoint = c & 0x07;
        } else {
            return false;
        }
        if (i + continuation > length) return false;
        for (unsigned j = 0; j < continuation; ++j) {
            uint8_t next = text[i++];
            if ((next & 0xc0) != 0x80) return false;
            codepoint = (codepoint << 6) | (next & 0x3f);
        }
        if ((continuation == 1 && codepoint < 0x80) ||
            (continuation == 2 && codepoint < 0x800) ||
            (continuation == 3 && codepoint < 0x10000) ||
            codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
            return false;
        }
    }
    return true;
}

static esp_err_t parse_public_identity(const cJSON *value, fm_public_identity_t *identity) {
    static const char *const fields[] = {
        "id", "signingPublicKey", "encryptionPublicKey",
    };
    if (!exact_object(value, fields, 3)) return ESP_ERR_INVALID_ARG;
    esp_err_t err = copy_string(value, "id", FM_MAX_ID_BYTES, &identity->id);
    if (err == ESP_OK) {
        err = copy_string(value, "signingPublicKey", FM_MAX_PEM_BYTES,
                          &identity->signing_public_pem);
    }
    if (err == ESP_OK) {
        err = copy_string(value, "encryptionPublicKey", FM_MAX_PEM_BYTES,
                          &identity->encryption_public_pem);
    }
    if (err == ESP_OK) {
        err = fm_parse_ed25519_public_pem(identity->signing_public_pem,
                                          identity->signing_public);
    }
    if (err == ESP_OK) {
        err = fm_parse_x25519_public_pem(identity->encryption_public_pem,
                                         identity->encryption_public);
    }
    return err;
}

const fm_public_identity_t *fm_config_roster_find(const fm_config_t *config, const char *id) {
    for (size_t i = 0; i < config->roster_count; ++i) {
        if (strcmp(config->roster[i].id, id) == 0) return &config->roster[i];
    }
    return NULL;
}

static bool valid_peer_url(const char *url) {
    size_t length = strlen(url);
    if (length < 8 || strncmp(url, "http://", 7) != 0 || url[length - 1] == '/') return false;
    const char *authority = url + 7;
    return *authority && !strchr(authority, '/') && !strchr(authority, '?') &&
           !strchr(authority, '#') && !strchr(authority, '@');
}

static esp_err_t parse_configuration(cJSON *root, fm_config_t *config) {
    static const char *const root_fields[] = {
        "version", "fleet", "authority", "identity", "roster", "peers",
        "contactIntervalMs", "contactTimeoutMs",
    };
    static const char *const authority_fields[] = {"id", "publicKey"};
    static const char *const identity_fields[] = {
        "id", "signingPublicKey", "encryptionPublicKey", "signingPrivateKey",
        "encryptionPrivateKey",
    };
    static const char *const peer_fields[] = {"id", "url"};
    if (!exact_object(root, root_fields, 8)) return ESP_ERR_INVALID_ARG;
    cJSON *version = last_field(root, "version");
    cJSON *authority = last_field(root, "authority");
    cJSON *identity = last_field(root, "identity");
    cJSON *roster = last_field(root, "roster");
    cJSON *peers = last_field(root, "peers");
    cJSON *interval = last_field(root, "contactIntervalMs");
    cJSON *timeout = last_field(root, "contactTimeoutMs");
    if (!safe_integer(version, 1, 1) || !exact_object(authority, authority_fields, 2) ||
        !exact_object(identity, identity_fields, 5) || !cJSON_IsArray(roster) ||
        !cJSON_IsArray(peers) || !safe_integer(interval, 1, INT32_MAX) ||
        !safe_integer(timeout, 1, INT32_MAX)) {
        return ESP_ERR_INVALID_ARG;
    }
    config->version = 1;
    config->contact_interval_ms = (uint32_t)interval->valuedouble;
    config->contact_timeout_ms = (uint32_t)timeout->valuedouble;
    esp_err_t err = copy_string(root, "fleet", FM_MAX_ID_BYTES, &config->fleet);
    if (err == ESP_OK) err = copy_string(authority, "id", FM_MAX_ID_BYTES,
                                          &config->authority_id);
    if (err == ESP_OK) err = copy_string(authority, "publicKey", FM_MAX_PEM_BYTES,
                                          &config->authority_public_pem);
    if (err == ESP_OK) err = fm_parse_ed25519_public_pem(config->authority_public_pem,
                                                         config->authority_public);
    if (err == ESP_OK) err = copy_string(identity, "id", FM_MAX_ID_BYTES,
                                          &config->identity_id);
    if (err == ESP_OK) err = copy_string(identity, "signingPublicKey", FM_MAX_PEM_BYTES,
                                          &config->signing_public_pem);
    if (err == ESP_OK) err = copy_string(identity, "encryptionPublicKey", FM_MAX_PEM_BYTES,
                                          &config->encryption_public_pem);
    if (err == ESP_OK) err = copy_string(identity, "signingPrivateKey", FM_MAX_PEM_BYTES,
                                          &config->signing_private_pem);
    if (err == ESP_OK) err = copy_string(identity, "encryptionPrivateKey", FM_MAX_PEM_BYTES,
                                          &config->encryption_private_pem);
    if (err == ESP_OK) err = fm_parse_ed25519_public_pem(config->signing_public_pem,
                                                         config->signing_public);
    if (err == ESP_OK) err = fm_parse_x25519_public_pem(config->encryption_public_pem,
                                                        config->encryption_public);
    if (err == ESP_OK) err = fm_parse_ed25519_private_pem(config->signing_private_pem,
                                                          config->signing_seed);
    if (err == ESP_OK) err = fm_parse_x25519_private_pem(config->encryption_private_pem,
                                                         config->encryption_private);
    if (err != ESP_OK) return err;

    uint8_t derived_signing_public[crypto_sign_PUBLICKEYBYTES];
    uint8_t signing_secret[crypto_sign_SECRETKEYBYTES];
    uint8_t derived_encryption_public[crypto_scalarmult_curve25519_BYTES];
    crypto_sign_seed_keypair(derived_signing_public, signing_secret, config->signing_seed);
    crypto_scalarmult_curve25519_base(derived_encryption_public, config->encryption_private);
    sodium_memzero(signing_secret, sizeof(signing_secret));
    if (sodium_memcmp(derived_signing_public, config->signing_public, FM_KEY_BYTES) != 0 ||
        sodium_memcmp(derived_encryption_public, config->encryption_public, FM_KEY_BYTES) != 0) {
        return ESP_ERR_INVALID_ARG;
    }

    int roster_size = cJSON_GetArraySize(roster);
    if (roster_size < 1 || roster_size > FM_MAX_ROSTER) return ESP_ERR_INVALID_SIZE;
    for (int i = 0; i < roster_size; ++i) {
        fm_public_identity_t *entry = &config->roster[config->roster_count];
        err = parse_public_identity(cJSON_GetArrayItem(roster, i), entry);
        if (err != ESP_OK) return err;
        if (fm_config_roster_find(config, entry->id)) return ESP_ERR_INVALID_ARG;
        config->roster_count++;
    }
    const fm_public_identity_t *local = fm_config_roster_find(config, config->identity_id);
    if (!local || strcmp(local->signing_public_pem, config->signing_public_pem) != 0 ||
        strcmp(local->encryption_public_pem, config->encryption_public_pem) != 0) {
        return ESP_ERR_INVALID_ARG;
    }

    int peer_size = cJSON_GetArraySize(peers);
    if (peer_size < 1 || peer_size > FM_MAX_PEERS) return ESP_ERR_INVALID_SIZE;
    for (int i = 0; i < peer_size; ++i) {
        cJSON *peer = cJSON_GetArrayItem(peers, i);
        if (!exact_object(peer, peer_fields, 2)) return ESP_ERR_INVALID_ARG;
        fm_peer_t *entry = &config->peers[config->peer_count];
        err = copy_string(peer, "id", FM_MAX_ID_BYTES, &entry->id);
        if (err == ESP_OK) err = copy_string(peer, "url", FM_MAX_URL_BYTES, &entry->url);
        if (err != ESP_OK || !valid_peer_url(entry->url) ||
            strcmp(entry->id, config->identity_id) == 0 ||
            !fm_config_roster_find(config, entry->id)) {
            return ESP_ERR_INVALID_ARG;
        }
        for (size_t j = 0; j < config->peer_count; ++j) {
            if (strcmp(config->peers[j].id, entry->id) == 0) return ESP_ERR_INVALID_ARG;
        }
        config->peer_count++;
    }
    return ESP_OK;
}

esp_err_t fm_config_load(fm_config_t *config) {
    memset(config, 0, sizeof(*config));
    const esp_partition_t *partition = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, FM_CFG_PARTITION_SUBTYPE, "fleet_cfg");
    if (!partition || partition->address != FM_CFG_PARTITION_OFFSET ||
        partition->size != FM_CFG_PARTITION_SIZE) {
        ESP_LOGE(TAG, "fleet_cfg partition location does not match the provision contract");
        return ESP_ERR_NOT_FOUND;
    }
    const void *mapped = NULL;
    esp_partition_mmap_handle_t map = 0;
    esp_err_t err = esp_partition_mmap(partition, 0, partition->size,
                                       ESP_PARTITION_MMAP_DATA, &mapped, &map);
    if (err != ESP_OK) return err;
    const uint8_t *image = mapped;
    uint32_t length = (uint32_t)image[0] | ((uint32_t)image[1] << 8) |
                      ((uint32_t)image[2] << 16) | ((uint32_t)image[3] << 24);
    if (length == 0 || length > partition->size - 4 || length > FM_BODY_MAX - 1 ||
        !valid_utf8(image + 4, length) || memchr(image + 4, '\0', length) ||
        json_has_nul_escape(image + 4, length)) {
        esp_partition_munmap(map);
        return ESP_ERR_INVALID_SIZE;
    }
    for (size_t i = 4 + length; i < partition->size; ++i) {
        if (image[i] != 0xff) {
            esp_partition_munmap(map);
            return ESP_ERR_INVALID_ARG;
        }
    }
    char *json = malloc(length + 1);
    if (!json) {
        esp_partition_munmap(map);
        return ESP_ERR_NO_MEM;
    }
    memcpy(json, image + 4, length);
    json[length] = '\0';
    esp_partition_munmap(map);
    const char *end = NULL;
    cJSON *root = cJSON_ParseWithLengthOpts(json, length + 1, &end, true);
    if (!root || end != json + length) {
        cJSON_Delete(root);
        free(json);
        return ESP_ERR_INVALID_ARG;
    }
    err = parse_configuration(root, config);
    ESP_LOGI(TAG, "validated provisioned configuration: %s", esp_err_to_name(err));
    cJSON_Delete(root);
    free(json);
    if (err != ESP_OK) fm_config_free(config);
    return err;
}

void fm_config_free(fm_config_t *config) {
    free(config->fleet);
    free(config->authority_id);
    free(config->authority_public_pem);
    free(config->identity_id);
    free(config->signing_public_pem);
    free(config->encryption_public_pem);
    free(config->signing_private_pem);
    free(config->encryption_private_pem);
    for (size_t i = 0; i < FM_MAX_ROSTER; ++i) {
        free(config->roster[i].id);
        free(config->roster[i].signing_public_pem);
        free(config->roster[i].encryption_public_pem);
    }
    for (size_t i = 0; i < FM_MAX_PEERS; ++i) {
        free(config->peers[i].id);
        free(config->peers[i].url);
    }
    sodium_memzero(config, sizeof(*config));
}
