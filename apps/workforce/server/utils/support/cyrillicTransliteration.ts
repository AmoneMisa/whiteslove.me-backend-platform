// Cyrillic -> Latin mappings for Elasticsearch `mapping` char filters.
//
// Why not icu_transform: it needs the analysis-icu plugin, whose download 403s
// on this host. An index definition that references a missing analyzer fails to
// create *entirely*, which silently leaves search with no index at all. A core
// `mapping` char filter needs no plugin and is applied before tokenizing, so
// "Мария"/"Mariya" and "разработчик"/"razrabotchik" produce the same tokens.
//
// Shared by the job and candidate indices so both sides transliterate
// identically — otherwise a query would match one index but not the other.
//
// The letter -> Latin table itself comes from parsing-lexicon's
// CYRILLIC_SEARCH_MAP (the same table foldCyrillicForSearch uses at query
// time), so index-time and query-time folding can't drift apart.

import { CYRILLIC_SEARCH_MAP } from '@whiteslove/parsing-lexicon/normalization'

// Elasticsearch mapping char filters take "from => to" rules and are
// case-sensitive, so each letter is emitted in both cases. Letters that fold
// to '' (ъ, ь) emit an empty-target rule, which ES treats as deletion.
export function transliterationMappings(): string[] {
    const out: string[] = []
    for (const [cyrillic, latin] of Object.entries(CYRILLIC_SEARCH_MAP)) {
        out.push(`${cyrillic} => ${latin}`)
        out.push(`${cyrillic.toUpperCase()} => ${latin}`)
    }
    return out
}
