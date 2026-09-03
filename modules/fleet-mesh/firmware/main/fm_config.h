#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "fm_crypto.h"
#include "fm_limits.h"

typedef struct {
    char *id;
    char *signing_public_pem;
    char *encryption_public_pem;
    uint8_t signing_public[FM_KEY_BYTES];
    uint8_t encryption_public[FM_KEY_BYTES];
} fm_public_identity_t;

typedef struct {
    char *id;
    char *url;
} fm_peer_t;

typedef struct {
    uint32_t version;
    char *fleet;
    char *authority_id;
    char *authority_public_pem;
    uint8_t authority_public[FM_KEY_BYTES];
    char *identity_id;
    char *signing_public_pem;
    char *encryption_public_pem;
    char *signing_private_pem;
    char *encryption_private_pem;
    uint8_t signing_public[FM_KEY_BYTES];
    uint8_t encryption_public[FM_KEY_BYTES];
    uint8_t signing_seed[FM_KEY_BYTES];
    uint8_t encryption_private[FM_KEY_BYTES];
    fm_public_identity_t roster[FM_MAX_ROSTER];
    size_t roster_count;
    fm_peer_t peers[FM_MAX_PEERS];
    size_t peer_count;
    uint32_t contact_interval_ms;
    uint32_t contact_timeout_ms;
} fm_config_t;

esp_err_t fm_config_load(fm_config_t *config);
void fm_config_free(fm_config_t *config);
const fm_public_identity_t *fm_config_roster_find(const fm_config_t *config, const char *id);
