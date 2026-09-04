#pragma once

#include <stdbool.h>
#include <sys/time.h>

#include "esp_err.h"

typedef struct {
    void *synchronized;
} fm_clock_t;

esp_err_t fm_clock_start(fm_clock_t *clock);
bool fm_clock_now(const fm_clock_t *clock, struct timeval *now);
