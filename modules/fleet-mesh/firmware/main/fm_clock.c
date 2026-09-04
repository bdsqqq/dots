#include "fm_clock.h"

#include <inttypes.h>
#include <string.h>

#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "fm_openeth.h"
#include "sdkconfig.h"

static const char *TAG = "fleet-clock";
static const EventBits_t SYNCHRONIZED = BIT0;

static void synchronize(void *argument) {
    fm_clock_t *clock = argument;
    while (fm_openeth_wait_for_ip(30000) != ESP_OK) {
        ESP_LOGW(TAG, "waiting for DHCP before starting SNTP");
    }

    esp_err_t err = esp_netif_sntp_start();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "cannot start SNTP: %s", esp_err_to_name(err));
        vTaskDelete(NULL);
        return;
    }

    for (;;) {
        err = esp_netif_sntp_sync_wait(pdMS_TO_TICKS(60000));
        if (err == ESP_OK) {
            struct timeval now;
            if (gettimeofday(&now, NULL) == 0) {
                xEventGroupSetBits((EventGroupHandle_t)clock->synchronized, SYNCHRONIZED);
                ESP_LOGI(TAG, "wall clock synchronized at %" PRId64,
                         (int64_t)now.tv_sec);
            }
        } else if (err == ESP_ERR_TIMEOUT) {
            if (!(xEventGroupGetBits((EventGroupHandle_t)clock->synchronized) &
                  SYNCHRONIZED)) {
                ESP_LOGW(TAG, "SNTP synchronization pending");
            }
        } else {
            ESP_LOGE(TAG, "SNTP synchronization failed: %s", esp_err_to_name(err));
            vTaskDelete(NULL);
            return;
        }
    }
}

esp_err_t fm_clock_start(fm_clock_t *clock) {
    memset(clock, 0, sizeof(*clock));
    clock->synchronized = xEventGroupCreate();
    if (!clock->synchronized) return ESP_ERR_NO_MEM;

    esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG(CONFIG_FLEET_TIME_SERVER);
    config.start = false;
    esp_err_t err = esp_netif_sntp_init(&config);
    if (err != ESP_OK) {
        vEventGroupDelete((EventGroupHandle_t)clock->synchronized);
        clock->synchronized = NULL;
        return err;
    }
    if (xTaskCreate(synchronize, "fleet-clock", 4096, clock, 5, NULL) != pdPASS) {
        esp_netif_sntp_deinit();
        vEventGroupDelete((EventGroupHandle_t)clock->synchronized);
        clock->synchronized = NULL;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

bool fm_clock_now(const fm_clock_t *clock, struct timeval *now) {
    if (!clock || !clock->synchronized ||
        !(xEventGroupGetBits((EventGroupHandle_t)clock->synchronized) & SYNCHRONIZED)) {
        return false;
    }
    return gettimeofday(now, NULL) == 0;
}
