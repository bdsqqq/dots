#pragma once

#include "esp_err.h"
#include "fm_config.h"
#include "fm_protocol.h"

esp_err_t fm_http_start(fm_protocol_t *protocol, const fm_config_t *config);
esp_err_t fm_peer_loop_start(fm_protocol_t *protocol, const fm_config_t *config);
