function searchableText() {
    return {
        type: 'text',
        analyzer: 'flat_text',
        fields: {
            latin: {
                type: 'text',
                analyzer: 'flat_latin',
            },
        },
    };
}

function locationText() {
    return {
        type: 'text',
        analyzer: 'flat_text',
        fields: {
            latin: {
                type: 'text',
                analyzer: 'flat_latin',
            },
            raw: {
                type: 'keyword',
                normalizer: 'flat_keyword',
            },
        },
    };
}

export function indexDefinition() {
    return {
        settings: {
            number_of_shards: 1,
            number_of_replicas: 0,

            analysis: {
                filter: {
                    flat_ascii: {
                        type: 'asciifolding',
                        preserve_original: true,
                    },

                    flat_transliteration: {
                        type: 'icu_transform',
                        id:
                            'Any-Latin; ' +
                            'NFD; ' +
                            '[:Nonspacing Mark:] Remove; ' +
                            'NFC',
                    },
                },

                analyzer: {
                    /*
                     * Обычный текст:
                     *
                     * București → bucuresti
                     * CHILANZAR → chilanzar
                     */
                    flat_text: {
                        type: 'custom',
                        tokenizer: 'standard',
                        filter: ['lowercase', 'flat_ascii'],
                    },

                    /*
                     * Транслитерированное поле:
                     *
                     * Чиланзар → cilanzar
                     * квартира → kvartira
                     */
                    flat_latin: {
                        type: 'custom',
                        tokenizer: 'standard',
                        filter: [
                            'flat_transliteration',
                            'lowercase',
                            'flat_ascii',
                        ],
                    },
                },

                normalizer: {
                    flat_keyword: {
                        type: 'custom',
                        filter: ['lowercase', 'asciifolding'],
                    },
                },
            },
        },

        mappings: {
            /*
             * Новые поля Listing можно хранить в _source, но они
             * автоматически не создадут тысячи mappings.
             */
            dynamic: false,

            properties: {
                id: {type: 'keyword'},
                source: {type: 'keyword'},
                country: {type: 'keyword'},

                title: searchableText(),
                description: searchableText(),

                propertyType: {type: 'keyword'},
                dealType: {type: 'keyword'},

                city: locationText(),
                district: locationText(),
                area: locationText(),
                kvartal: locationText(),
                metro: locationText(),
                microdistrict: locationText(),
                address: locationText(),

                /*
                 * Что вокруг дома — заполняется по координатам
                 * (nearby-places.js) из таблицы places.
                 *
                 * nested, а не object: иначе «Новза ближе 500 м»
                 * совпадёт с любым домом, у которого есть и
                 * Новза, и что-нибудь в 500 м — но не одновременно.
                 */
                metroNearby: {
                    type: 'nested',
                    properties: {
                        name: {
                            type: 'keyword',
                            normalizer: 'flat_keyword',
                        },
                        nameRu: {
                            type: 'keyword',
                            normalizer: 'flat_keyword',
                        },
                        distanceM: {type: 'integer'},
                    },
                },

                nearbyPlaces: {
                    type: 'nested',
                    properties: {
                        name: searchableText(),
                        kind: {type: 'keyword'},
                        distanceM: {type: 'integer'},
                    },
                },

                landmarksNearby: {
                    type: 'nested',
                    properties: {
                        name: {
                            type: 'keyword',
                            normalizer: 'flat_keyword',
                        },
                        distanceM: {type: 'integer'},
                    },
                },

                /*
                 * Плоская копия названий для обычного поиска:
                 * nested-поля multi_match не видит.
                 *
                 * Намеренно НЕ в SEARCH_FIELDS: «IT Park» иначе
                 * вернёт всё в радиусе трёх километров. Это поле
                 * для отдельного фильтра «рядом с ...».
                 */
                placeNames: searchableText(),

                metroDistanceM: {type: 'integer'},
                metroSource: {type: 'keyword'},
                placesSource: {type: 'keyword'},
                adminSource: {type: 'keyword'},

                residenceComplex: locationText(),

                nearby: searchableText(),
                nearbyShops: searchableText(),
                amenities: searchableText(),
                tags: searchableText(),
                contact: searchableText(),

                price: {type: 'double'},
                currency: {type: 'keyword'},
                rooms: {type: 'integer'},
                bedrooms: {type: 'integer'},
                bathrooms: {type: 'integer'},
                areaSqm: {type: 'double'},
                floor: {type: 'integer'},
                totalFloors: {type: 'integer'},
                buildingYear: {type: 'integer'},

                byAgency: {type: 'boolean'},
                commercial: {type: 'boolean'},
                roomOnly: {type: 'boolean'},
                petsAllowed: {type: 'boolean'},
                childrenAllowed: {type: 'boolean'},
                furnished: {type: 'boolean'},
                newBuilding: {type: 'boolean'},
                balcony: {type: 'boolean'},
                parking: {type: 'boolean'},
                elevator: {type: 'boolean'},
                airConditioner: {type: 'boolean'},
                internet: {type: 'boolean'},
                negotiable: {type: 'boolean'},

                createdAt: {type: 'date'},
                firstSeenAt: {type: 'date'},
                lastSeenAt: {type: 'date'},
                updatedAt: {type: 'date'},

                active: {type: 'boolean'},
                location: {type: 'geo_point'},
            },
        },
    };
}
