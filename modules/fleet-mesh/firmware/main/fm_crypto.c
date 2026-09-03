#include "fm_crypto.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mbedtls/base64.h"
#include "mbedtls/gcm.h"
#include "mbedtls/md.h"
#include "mbedtls/sha256.h"
#include "sodium.h"

static const uint8_t ED25519_SPKI_PREFIX[] = {
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
};
static const uint8_t X25519_SPKI_PREFIX[] = {
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
};
static const uint8_t ED25519_PKCS8_PREFIX[] = {
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
};
static const uint8_t X25519_PKCS8_PREFIX[] = {
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
    0x04, 0x22, 0x04, 0x20,
};

esp_err_t fm_crypto_init(void) {
    return sodium_init() < 0 ? ESP_FAIL : ESP_OK;
}

esp_err_t fm_base64_encode(const uint8_t *input, size_t input_len, char **output) {
    size_t capacity = 4 * ((input_len + 2) / 3) + 1;
    char *text = malloc(capacity);
    if (!text) return ESP_ERR_NO_MEM;
    size_t written = 0;
    if (mbedtls_base64_encode((uint8_t *)text, capacity, &written, input, input_len) != 0) {
        free(text);
        return ESP_FAIL;
    }
    text[written] = '\0';
    *output = text;
    return ESP_OK;
}

esp_err_t fm_base64_decode_permissive(const char *text, uint8_t **output, size_t *output_len) {
    size_t length = strlen(text);
    char *normalized = malloc(length + 5);
    if (!normalized) return ESP_ERR_NO_MEM;
    size_t normalized_len = 0;
    for (size_t i = 0; i < length; ++i) {
        char c = text[i];
        if (c == '=') break;
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '+' || c == '/') {
            normalized[normalized_len++] = c;
        } else if (c == '-') {
            normalized[normalized_len++] = '+';
        } else if (c == '_') {
            normalized[normalized_len++] = '/';
        }
        /* Node's v1 Buffer decoder ignores whitespace and non-alphabet bytes. */
    }
    while ((normalized_len % 4) != 0) normalized[normalized_len++] = '=';
    normalized[normalized_len] = '\0';

    size_t capacity = (normalized_len / 4) * 3 + 1;
    uint8_t *bytes = malloc(capacity ? capacity : 1);
    if (!bytes) {
        free(normalized);
        return ESP_ERR_NO_MEM;
    }
    size_t written = 0;
    int result = mbedtls_base64_decode(bytes, capacity, &written,
                                       (const uint8_t *)normalized, normalized_len);
    free(normalized);
    if (result != 0) {
        free(bytes);
        return ESP_ERR_INVALID_ARG;
    }
    *output = bytes;
    *output_len = written;
    return ESP_OK;
}

static esp_err_t canonical_pem(const uint8_t *der, size_t der_len, const char *begin,
                               const char *end, char **pem) {
    char *body = NULL;
    esp_err_t err = fm_base64_encode(der, der_len, &body);
    if (err != ESP_OK) return err;
    size_t length = strlen(begin) + strlen(body) + strlen(end) + 4;
    char *result = malloc(length);
    if (!result) {
        free(body);
        return ESP_ERR_NO_MEM;
    }
    snprintf(result, length, "%s\n%s\n%s\n", begin, body, end);
    free(body);
    *pem = result;
    return ESP_OK;
}

static esp_err_t parse_canonical_pem(const char *pem, const uint8_t *prefix,
                                     size_t prefix_len, const char *begin, const char *end,
                                     uint8_t raw[FM_KEY_BYTES]) {
    const char *body_start = strstr(pem, "\n");
    if (!body_start || strncmp(pem, begin, strlen(begin)) != 0) return ESP_ERR_INVALID_ARG;
    body_start++;
    const char *body_end = strstr(body_start, "\n-----END ");
    if (!body_end) return ESP_ERR_INVALID_ARG;
    size_t body_len = (size_t)(body_end - body_start);
    char *body = strndup(body_start, body_len);
    if (!body) return ESP_ERR_NO_MEM;
    uint8_t *der = NULL;
    size_t der_len = 0;
    esp_err_t err = fm_base64_decode_permissive(body, &der, &der_len);
    free(body);
    if (err != ESP_OK) return err;
    if (der_len != prefix_len + FM_KEY_BYTES || memcmp(der, prefix, prefix_len) != 0) {
        free(der);
        return ESP_ERR_INVALID_ARG;
    }
    char *canonical = NULL;
    err = canonical_pem(der, der_len, begin, end, &canonical);
    if (err == ESP_OK && strcmp(canonical, pem) != 0) err = ESP_ERR_INVALID_ARG;
    if (err == ESP_OK) memcpy(raw, der + prefix_len, FM_KEY_BYTES);
    free(canonical);
    sodium_memzero(der, der_len);
    free(der);
    return err;
}

esp_err_t fm_parse_ed25519_public_pem(const char *pem, uint8_t raw[FM_KEY_BYTES]) {
    return parse_canonical_pem(pem, ED25519_SPKI_PREFIX, sizeof(ED25519_SPKI_PREFIX),
                               "-----BEGIN PUBLIC KEY-----", "-----END PUBLIC KEY-----", raw);
}

esp_err_t fm_parse_ed25519_private_pem(const char *pem, uint8_t seed[FM_KEY_BYTES]) {
    return parse_canonical_pem(pem, ED25519_PKCS8_PREFIX, sizeof(ED25519_PKCS8_PREFIX),
                               "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----", seed);
}

esp_err_t fm_parse_x25519_public_pem(const char *pem, uint8_t raw[FM_KEY_BYTES]) {
    return parse_canonical_pem(pem, X25519_SPKI_PREFIX, sizeof(X25519_SPKI_PREFIX),
                               "-----BEGIN PUBLIC KEY-----", "-----END PUBLIC KEY-----", raw);
}

esp_err_t fm_parse_x25519_private_pem(const char *pem, uint8_t raw[FM_KEY_BYTES]) {
    return parse_canonical_pem(pem, X25519_PKCS8_PREFIX, sizeof(X25519_PKCS8_PREFIX),
                               "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----", raw);
}

esp_err_t fm_format_x25519_public_pem(const uint8_t raw[FM_KEY_BYTES], char **pem) {
    uint8_t der[sizeof(X25519_SPKI_PREFIX) + FM_KEY_BYTES];
    memcpy(der, X25519_SPKI_PREFIX, sizeof(X25519_SPKI_PREFIX));
    memcpy(der + sizeof(X25519_SPKI_PREFIX), raw, FM_KEY_BYTES);
    return canonical_pem(der, sizeof(der), "-----BEGIN PUBLIC KEY-----",
                         "-----END PUBLIC KEY-----", pem);
}

esp_err_t fm_sha256_hex(const uint8_t *input, size_t input_len, char output[65]) {
    uint8_t digest[32];
    if (mbedtls_sha256(input, input_len, digest, 0) != 0) return ESP_FAIL;
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < sizeof(digest); ++i) {
        output[i * 2] = hex[digest[i] >> 4];
        output[i * 2 + 1] = hex[digest[i] & 0x0f];
    }
    output[64] = '\0';
    sodium_memzero(digest, sizeof(digest));
    return ESP_OK;
}

bool fm_ed25519_verify(const uint8_t public_key[FM_KEY_BYTES], const uint8_t *message,
                       size_t message_len, const char *signature_text) {
    uint8_t *signature = NULL;
    size_t signature_len = 0;
    if (fm_base64_decode_permissive(signature_text, &signature, &signature_len) != ESP_OK) {
        return false;
    }
    bool valid = signature_len == crypto_sign_BYTES &&
                 crypto_sign_verify_detached(signature, message,
                                             (unsigned long long)message_len,
                                             public_key) == 0;
    free(signature);
    return valid;
}

esp_err_t fm_ed25519_sign(const uint8_t seed[FM_KEY_BYTES], const uint8_t *message,
                          size_t message_len, char **signature_text) {
    uint8_t public_key[crypto_sign_PUBLICKEYBYTES];
    uint8_t secret_key[crypto_sign_SECRETKEYBYTES];
    uint8_t signature[crypto_sign_BYTES];
    crypto_sign_seed_keypair(public_key, secret_key, seed);
    if (crypto_sign_detached(signature, NULL, message, (unsigned long long)message_len,
                             secret_key) != 0) {
        sodium_memzero(secret_key, sizeof(secret_key));
        return ESP_FAIL;
    }
    esp_err_t err = fm_base64_encode(signature, sizeof(signature), signature_text);
    sodium_memzero(secret_key, sizeof(secret_key));
    sodium_memzero(signature, sizeof(signature));
    return err;
}

esp_err_t fm_x25519_shared(const uint8_t private_key[FM_KEY_BYTES],
                           const uint8_t public_key[FM_KEY_BYTES],
                           uint8_t shared[FM_KEY_BYTES]) {
    return crypto_scalarmult_curve25519(shared, private_key, public_key) == 0
               ? ESP_OK
               : ESP_ERR_INVALID_ARG;
}

esp_err_t fm_hkdf_sha256(const uint8_t *ikm, size_t ikm_len, const uint8_t *salt,
                         size_t salt_len, const uint8_t *info, size_t info_len,
                         uint8_t *output, size_t output_len) {
    const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (!md || output_len > 255U * 32U) return ESP_ERR_INVALID_ARG;
    uint8_t prk[32];
    if (mbedtls_md_hmac(md, salt, salt_len, ikm, ikm_len, prk) != 0) return ESP_FAIL;
    uint8_t previous[32] = {0};
    size_t previous_len = 0;
    size_t offset = 0;
    uint8_t counter = 1;
    while (offset < output_len) {
        mbedtls_md_context_t context;
        mbedtls_md_init(&context);
        if (mbedtls_md_setup(&context, md, 1) != 0 ||
            mbedtls_md_hmac_starts(&context, prk, sizeof(prk)) != 0 ||
            (previous_len && mbedtls_md_hmac_update(&context, previous, previous_len) != 0) ||
            (info_len && mbedtls_md_hmac_update(&context, info, info_len) != 0) ||
            mbedtls_md_hmac_update(&context, &counter, 1) != 0 ||
            mbedtls_md_hmac_finish(&context, previous) != 0) {
            mbedtls_md_free(&context);
            sodium_memzero(prk, sizeof(prk));
            return ESP_FAIL;
        }
        mbedtls_md_free(&context);
        previous_len = sizeof(previous);
        size_t take = output_len - offset < sizeof(previous) ? output_len - offset
                                                              : sizeof(previous);
        memcpy(output + offset, previous, take);
        offset += take;
        counter++;
    }
    sodium_memzero(prk, sizeof(prk));
    sodium_memzero(previous, sizeof(previous));
    return ESP_OK;
}

esp_err_t fm_aes256_gcm_decrypt(const uint8_t key[32], const uint8_t *iv, size_t iv_len,
                                const uint8_t *aad, size_t aad_len,
                                const uint8_t *ciphertext, size_t ciphertext_len,
                                const uint8_t tag[16], uint8_t *plaintext) {
    mbedtls_gcm_context context;
    mbedtls_gcm_init(&context);
    int result = mbedtls_gcm_setkey(&context, MBEDTLS_CIPHER_ID_AES, key, 256);
    if (result == 0) {
        result = mbedtls_gcm_auth_decrypt(&context, ciphertext_len, iv, iv_len, aad,
                                         aad_len, tag, FM_AES_GCM_TAG_BYTES,
                                         ciphertext, plaintext);
    }
    mbedtls_gcm_free(&context);
    return result == 0 ? ESP_OK : ESP_ERR_INVALID_CRC;
}
