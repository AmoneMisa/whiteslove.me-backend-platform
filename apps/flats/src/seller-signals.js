// Shared seller/commission signals used by all free-text housing sources.
// Keep language variants here so Telegram/social/normalization do not drift.

const DIRECT_OWNER_RE = /(?:без\s+(?:макл(?:ер[а-яё]*)?|посредник[а-яё]*|ри[еэ]?лтор[а-яё]*|агент[а-яё]*)|от\s+(?:собственник[а-яё]*|хозяин[а-яё]*)|від\s+(?:власник[а-яіїґ]*|власниц[яії][а-яіїґ]*|господар[а-яіїґ]*)|без\s+(?:посередник[а-яіїґ]*|рі[єе]лтор[а-яіїґ]*|агент[а-яіїґ]*)|прямо\s+від\s+(?:власник[а-яіїґ]*|власниц[яії][а-яіїґ]*|господар[а-яіїґ]*)|(?:власник|власниця)\s+(?:зда[єе]|прода[єе])|no\s+(?:agency|broker|realtor|agent)|owner\s+direct|direct\s+from\s+(?:owner|landlord)|f(?:ă|a)r(?:ă|a)\s+(?:agen(?:ț|t)ie|intermediar\w*)|direct\s+(?:de\s+la\s+)?proprietar|makler\s*[- ]?siz|maklersiz|bez\s*makler(?:a|ov)?|bezmakler(?:a|ov)?|vositachi\s*[- ]?siz|vositachisiz|egasidan|uy\s+egasidan|делдалсыз|делдал\s*жоқ|иесінен|үй\s+иесінен)/iu;

const EXPLICIT_ZERO_COMMISSION_RE = /(?:без\s+(?:комисси[а-яё]*|комісі[а-яіїґ]*|комиссионн[а-яё]*)|no\s+(?:commission|agency\s+fee|broker\s+fee|realtor\s+fee|agent\s+fee)|f(?:ă|a)r(?:ă|a)\s+comision|komissiya\s*[- ]?siz|komissiyasiz|комиссиясыз|комиссия\s*жоқ)/iu;

export function isDirectOwner(text) {
  return Boolean(text) && DIRECT_OWNER_RE.test(String(text));
}

export function hasZeroCommissionSignal(text) {
  return isDirectOwner(text) || (Boolean(text) && EXPLICIT_ZERO_COMMISSION_RE.test(String(text)));
}
