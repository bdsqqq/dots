#pragma once

#include "esp_err.h"

esp_err_t fm_openeth_start(void);
esp_err_t fm_openeth_wait_for_ip(unsigned timeout_ms);
