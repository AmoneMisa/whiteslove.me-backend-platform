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

const CYRILLIC_TO_LATIN: Record<string, string> = {
    // Digraphs first; single letters after.
    ё: 'yo', ж: 'zh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ю: 'yu', я: 'ya',
    // Uzbek / Ukrainian specifics.
    ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h', є: 'ye', ї: 'yi', і: 'i', ґ: 'g',
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ъ: '', ы: 'i', ь: '', э: 'e',
}

// Elasticsearch mapping char filters take "from => to" rules and are
// case-sensitive, so each letter is emitted in both cases.
export function transliterationMappings(): string[] {
    const out: string[] = []
    for (const [cyrillic, latin] of Object.entries(CYRILLIC_TO_LATIN)) {
        out.push(`${cyrillic} => ${latin}`)
        out.push(`${cyrillic.toUpperCase()} => ${latin}`)
    }
    return out
}
