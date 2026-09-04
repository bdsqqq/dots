#pragma once

#include <stddef.h>
#include <stdint.h>

#include "cJSON.h"
#include "esp_err.h"
#include "fm_clock.h"
#include "fm_config.h"
#include "fm_limits.h"

typedef struct {
    int64_t epoch;
    int64_t sequence;
} fm_revision_t;

typedef struct {
    char *resource;
    fm_revision_t revision;
    char command_id[65];
    uint8_t *value_utf8;
    size_t value_len;
} fm_resource_state_t;

typedef struct {
    char command_id[65];
    char receipt_id[65];
    uint32_t executions;
} fm_outcome_t;

typedef struct {
    const fm_config_t *config;
    const fm_clock_t *clock;
    cJSON *records[FM_MAX_RECORDS];
    size_t record_count;
    fm_resource_state_t resources[FM_MAX_RESOURCES];
    size_t resource_count;
    fm_outcome_t outcomes[FM_MAX_OUTCOMES];
    size_t outcome_count;
    void *lock;
} fm_protocol_t;

esp_err_t fm_protocol_init(fm_protocol_t *protocol, const fm_config_t *config,
                           const fm_clock_t *clock);
void fm_protocol_deinit(fm_protocol_t *protocol);
esp_err_t fm_protocol_process_pending(fm_protocol_t *protocol);
esp_err_t fm_protocol_ingest(fm_protocol_t *protocol, const uint8_t *json, size_t json_len,
                             size_t *accepted);
esp_err_t fm_protocol_records_json(fm_protocol_t *protocol, char **json, size_t *json_len);
esp_err_t fm_protocol_gossip_response(fm_protocol_t *protocol, size_t accepted, char **json,
                                      size_t *json_len);
esp_err_t fm_protocol_self_test(void);
