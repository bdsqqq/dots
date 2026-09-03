#include "fm_openeth.h"

#include "sdkconfig.h"

#include "esp_eth.h"
#include "esp_eth_mac.h"
#include "esp_eth_phy.h"
#include "esp_eth_netif_glue.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

static const char *TAG = "fleet-openeth";
static EventGroupHandle_t events;
static const EventBits_t GOT_IP = BIT0;
static esp_eth_handle_t eth_handle;
static esp_netif_t *eth_netif;

static void got_ip(void *argument, esp_event_base_t base, int32_t event_id, void *event_data) {
    (void)argument; (void)base; (void)event_id;
    ip_event_got_ip_t *event = event_data;
    ESP_LOGI(TAG, "DHCP address " IPSTR, IP2STR(&event->ip_info.ip));
    xEventGroupSetBits(events, GOT_IP);
}

static void lost_ip(void *argument, esp_event_base_t base, int32_t event_id, void *event_data) {
    (void)argument; (void)base; (void)event_id; (void)event_data;
    xEventGroupClearBits(events, GOT_IP);
}

esp_err_t fm_openeth_start(void) {
#if !CONFIG_ETH_USE_OPENETH
#error "fleet firmware requires CONFIG_ETH_USE_OPENETH=y"
#endif
    events = xEventGroupCreate();
    if (!events) return ESP_ERR_NO_MEM;

    eth_mac_config_t mac_config = ETH_MAC_DEFAULT_CONFIG();
    eth_phy_config_t phy_config = ETH_PHY_DEFAULT_CONFIG();
    phy_config.phy_addr = 1;
    phy_config.reset_gpio_num = -1;
    esp_eth_mac_t *mac = esp_eth_mac_new_openeth(&mac_config);
    esp_eth_phy_t *phy = esp_eth_phy_new_dp83848(&phy_config);
    if (!mac || !phy) return ESP_ERR_NO_MEM;
    esp_eth_config_t config = ETH_DEFAULT_CONFIG(mac, phy);
    esp_err_t err = esp_eth_driver_install(&config, &eth_handle);
    if (err != ESP_OK) {
        mac->del(mac); phy->del(phy);
        return err;
    }
    esp_netif_config_t netif_config = ESP_NETIF_DEFAULT_ETH();
    eth_netif = esp_netif_new(&netif_config);
    if (!eth_netif) return ESP_ERR_NO_MEM;
    esp_eth_netif_glue_handle_t glue = esp_eth_new_netif_glue(eth_handle);
    if (!glue) return ESP_ERR_NO_MEM;
    err = esp_netif_attach(eth_netif, glue);
    if (err == ESP_OK) err = esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP,
                                                         &got_ip, NULL);
    if (err == ESP_OK) err = esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_LOST_IP,
                                                         &lost_ip, NULL);
    if (err == ESP_OK) err = esp_eth_start(eth_handle);
    return err;
}

esp_err_t fm_openeth_wait_for_ip(unsigned timeout_ms) {
    EventBits_t bits = xEventGroupWaitBits(events, GOT_IP, pdFALSE, pdTRUE,
                                           pdMS_TO_TICKS(timeout_ms));
    return (bits & GOT_IP) ? ESP_OK : ESP_ERR_TIMEOUT;
}
