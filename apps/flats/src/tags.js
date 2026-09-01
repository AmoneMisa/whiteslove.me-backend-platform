// Derives human-friendly tags for a listing card from its title + description.
// Keyword patterns cover EN / RO / RU / UA so tags work across all portals.

// Keyword patterns cover EN / RO / RU / UA / UZ / KZ so tags work across every
// portal, including Uzbek (Latin) and Kazakh (Cyrillic) posts.
const KEYWORD_TAGS = [
  ['furnished', /\b(furnished|mobilat|mebl|меблюванн|мебльован|с мебелью|обставлен|jihozlangan|jihozli|жиһаз)/i],
  ['unfurnished', /\b(unfurnished|nemobilat|без мебел|без меблів|jihozsiz|жиһazsіz|жиһазсыз)/i],
  ['renovated', /\b(renovat|euro ?renov|євроремонт|ремонт|отремонт|reamenajat|с ремонтом|ta'?mirlangan|remont|жөндел|жөндеу)/i],
  ['new build', /\b(new build|bloc nou|constructie noua|новострой|новобуд|новостро|yangi qurilgan|novostroyka|жаңа құрыл)/i],
  ['parking', /\b(parking|parcare|garaj|garage|гараж|парков|парко-?місц|avtoturargoh|avtomobil joyi|автотұрақ|көлік)/i],
  ['balcony', /\b(balcony|balcon|балкон|лоджи|лоджі|balkon|балкон)/i],
  ['elevator', /\b(elevator|lift|ліфт|лифт|lift|лифт)/i],
  ['pets ok', /\b(pets? ?(allowed|ok)|se accepta animale|можно с животными|з тваринами|uy hayvon|жануар)/i],
  ['no agency', /\b(no agency|fara intermediari|fără comision|без посредник|без агент|собственник|власник|від власника|vositachisiz|egasidan|иесінен)/i],
  ['utilities included', /\b(utilities included|utilitati incluse|комунальні включ|коммунальн.*включ|kommunal)/i],
  ['studio', /\b(studio|garsonier|студи[яї]|studiya)/i],
  ['air conditioning', /\b(air ?condition|\ba\/?c\b|conditioner|кондиционер|кондиціонер|konditsioner|klimat|klima\b|aer condi[țt]ionat)/i],
  ['microwave', /\b(microwave|микроволнов|мікрохвильов|mikroto'?lqinli|mikrovolnovka|cuptor cu microunde|СВЧ)/i],
  ['dishwasher', /\b(dishwasher|посудомо|посудомийн|idish yuvish|idishyuvg|ma[șs]ina de sp[ăa]lat vase)/i],
  ['washing machine', /\b(washing ?machine|стиральн(?:ая|ой) маш|пральн(?:а|ої) маш|kir yuvish|kir mashina|ma[șs]ina de sp[ăa]lat rufe)/i],
  ['central heating', /\b(central heating|centrala termica|central[ăa]|центральн.*отопл|опаленн|isitish|жылу)/i],
  ['pool', /\b(pool|piscina|бассейн|басейн|basseyn)/i],
  ['negotiable', /\b(negotiable|negociabil|торг(?! центр)|можен торг|kelishilgan|kelishamiz|келісім)/i],
  ['for rent', /\b(for rent|de inchiriat|inchiriere|оренда|аренда|сдам|сдаётся|здам|ijara|arenda|жалға)/i],
  ['for sale', /\b(for sale|de vanzare|vanzare|продаж|продажа|продам|продаётся|sotiladi|sotuv|сатылады)/i],
];

const DEAL_TAGS = { sale: 'for sale', longRent: 'long-term rent', shortRent: 'short-term rent' };
const AUDIENCE_TAGS = { women: 'girls only', men: 'men only', family: 'family' };

export function extractTags({
  title = '',
  description = '',
  byAgency,
  rooms,
  dealType,
  audience,
  district = null,
  nearby = [],
  residenceComplex = null,
  petsAllowed = null,
  childrenAllowed = null,
  roomOnly = false,
  deposit = null,
  commission = null,
  commissionPercent = null,
}) {
  const text = `${title} ${description}`.toLowerCase();
  const tags = [];

  if (rooms) tags.push(`${rooms} rooms`);
  if (dealType && DEAL_TAGS[dealType]) tags.push(DEAL_TAGS[dealType]);
  if (audience && AUDIENCE_TAGS[audience]) tags.push(AUDIENCE_TAGS[audience]);
  tags.push(byAgency ? 'agency' : 'owner');

  // Location context the user asked to surface: residential complex, district,
  // and nearby landmarks / orientation points.
  if (residenceComplex) tags.push(`ЖК ${residenceComplex}`);
  if (district) tags.push(district);
  for (const n of nearby ?? []) tags.push(n);

  // Tenant conditions + costs.
  if (roomOnly) tags.push('room only');
  if (petsAllowed === true) tags.push('pets ok');
  if (childrenAllowed === true) tags.push('children ok');
  if (deposit === true) tags.push('deposit');
  if (commission === false) tags.push('no commission');
  else if (commission === true)
    tags.push(commissionPercent ? `commission ${commissionPercent}%` : 'commission');

  for (const [tag, re] of KEYWORD_TAGS) {
    if (re.test(text)) tags.push(tag);
  }

  // De-duplicate while preserving order, cap to keep cards tidy.
  return [...new Set(tags)].slice(0, 12);
}
