#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define FM_KEY_BYTES 32
#define FM_ED25519_SIGNATURE_BYTES 64
#define FM_AES_GCM_TAG_BYTES 16

esp_err_t fm_crypto_init(void);
esp_err_t fm_parse_ed25519_public_pem(const char *pem, uint8_t raw[FM_KEY_BYTES]);
esp_err_t fm_parse_ed25519_private_pem(const char *pem, uint8_t seed[FM_KEY_BYTES]);
esp_err_t fm_parse_x25519_public_pem(const char *pem, uint8_t raw[FM_KEY_BYTES]);
esp_err_t fm_parse_x25519_private_pem(const char *pem, uint8_t raw[FM_KEY_BYTES]);
esp_err_t fm_format_x25519_public_pem(const uint8_t raw[FM_KEY_BYTES], char **pem);
esp_err_t fm_base64_decode_permissive(const char *text, uint8_t **output, size_t *output_len);
esp_err_t fm_base64_encode(const uint8_t *input, size_t input_len, char **output);
esp_err_t fm_sha256_hex(const uint8_t *input, size_t input_len, char output[65]);
bool fm_ed25519_verify(const uint8_t public_key[FM_KEY_BYTES], const uint8_t *message,
                       size_t message_len, const char *signature_text);
esp_err_t fm_ed25519_sign(const uint8_t seed[FM_KEY_BYTES], const uint8_t *message,
                          size_t message_len, char **signature_text);
esp_err_t fm_x25519_shared(const uint8_t private_key[FM_KEY_BYTES],
                           const uint8_t public_key[FM_KEY_BYTES],
                           uint8_t shared[FM_KEY_BYTES]);
esp_err_t fm_hkdf_sha256(const uint8_t *ikm, size_t ikm_len, const uint8_t *salt,
                         size_t salt_len, const uint8_t *info, size_t info_len,
                         uint8_t *output, size_t output_len);
esp_err_t fm_aes256_gcm_decrypt(const uint8_t key[32], const uint8_t *iv, size_t iv_len,
                                const uint8_t *aad, size_t aad_len,
                                const uint8_t *ciphertext, size_t ciphertext_len,
                                const uint8_t tag[16], uint8_t *plaintext);
