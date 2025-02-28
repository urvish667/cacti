/**
 *
 * Please note:
 * This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * Do not edit this file manually.
 *
 */

@file:Suppress(
    "ArrayInDataClass",
    "EnumEntryName",
    "RemoveRedundantQualifierName",
    "UnusedImport"
)

package org.openapitools.client.models


import com.squareup.moshi.Json

/**
 * 
 *
 * @param key The key for the entry to get from the keychain.
 */


data class GetKeychainEntryV1Request (

    /* The key for the entry to get from the keychain. */
    @Json(name = "key")
    val key: kotlin.Any?

) : kotlin.collections.HashMap<String, kotlin.Any>()

