// Vacancy risk + vagueness classification.
// Hard-block only high-confidence industry/scam patterns; ambiguous signals stay soft.

export type RiskCategory = 'gambling' | 'adult' | 'scam'

export interface SuspicionResult {
  riskCategory: RiskCategory | null
  riskReasons: string[]
  suspicious: boolean
  suspicionReasons: string[]
}

// ---- Hard-blocked: gambling / iGaming -------------------------------------
const GAMBLING = [
  ['casino', /\bcasino\b|казино|казіно|kazino/i],
  ['gambling', /\bgambling\b|азартн(?:ые|ых|ой|і)\s*игр|азартні\s*ігри|qimor/i],
  ['betting', /\bbetting\b|\bbookmaker\b|букмекер|беттинг|ставк[аи]\s+на\s+спорт|тотализатор/i],
  ['igaming', /\bi-?gaming\b|\bslots?\s+(?:provider|studio|game)|\bpoker\s+(?:room|club|operator)/i],
  ['betting-brand', /\b(?:1xbet|melbet|parimatch|betwinner|pin-?up|mostbet|1win)\b/i],
] as const

// ---- Hard-blocked: adult / OnlyFans-adjacent ------------------------------
const ADULT_STRONG = [
  ['onlyfans', /\bonly\s?fans\b|\bof-?модел|onlyfans-?модел/i],
  ['webcam', /\bweb\s?cam\s?(?:model|studio)|вебкам|веб-?кам|webcam-?модел/i],
  ['adult-content', /\badult\s+(?:content|industry|video|site)|порно|эротич|еротич|интим(?:н|ные услуги)|інтим/i],
  ['escort', /\bescort\b|эскорт|ескорт/i],
] as const
const ADULT_WEAK = /\bweb\s?model\b|веб-?модел|стример(?:ша|ов)?|стрімер|чат-?оператор|chat\s+operator|оператор\s+чат/i
const ADULT_SIGNAL = /18\+|только\s+девушк|лише\s+дівчат|откровенн|відверт|приватн(?:ые|ый)\s+(?:шоу|чат)|интимн|adult|пикантн|без\s+интима|для\s+девушек\s+от\s+18/i

// ---- Hard-blocked: earnings-bait / scam recruitment -----------------------
const SCAM = [
  ['easy-money', /лёгк(?:ий|ие)\s+(?:заработок|деньги)|легк(?:ий|ие)\s+(?:заработок|деньги)|быстр(?:ый|ые)\s+(?:заработок|деньги)|easy\s+money|швидк(?:ий|і)\s+заробіт/i],
  ['daily-payout', /выплаты\s+(?:ежедневно|каждый\s+день)|ежедневн(?:ые|ая)\s+выплат|оплата\s+каждый\s+день|щоденн[іа]\s+виплат/i],
  ['guaranteed-income', /гарантированн(?:ый|ого)\s+доход|гарантований\s+дохід|guaranteed\s+income|доход\s+от\s+\d[\d\s]{2,}\s*(?:\$|usd|у\.?е\.?)\s*в\s*(?:день|неделю)/i],
  ['no-investment', /без\s+вложений|без\s+вкладень|no\s+investment\s+required/i],
  ['mlm', /сетев(?:ой|ого)\s+(?:маркетинг|бизнес)|\bmlm\b|млм|финансов(?:ая|ой)\s+независимост|пассивн(?:ый|ого)\s+доход/i],
  ['crypto-bait', /гарантированн[а-яёіїєґ]*\s+(?:прибыл|профит)|трейдинг\s+с\s+гарант|инвестиц[а-яёіїєґ]*\s+с\s+гарант/i],
] as const

const SCAM_CONTACTS = [
  ['telegram:valery_hr_36', /(?:^|[^a-z0-9_])@?valery_hr_36(?:$|[^a-z0-9_])/i],
  ['telegram:kris_mogelevich7', /(?:^|[^a-z0-9_])@?kris_mogelevich7(?:$|[^a-z0-9_])/i],
  ['telegram:gasgazz_07', /(?:^|[^a-z0-9_])@?gasgazz_07(?:$|[^a-z0-9_])/i],
  ['phone:+998992993435', /(?:\+?998[\s()-]*)99[\s()-]*299[\s()-]*34[\s()-]*35/],
  ['phone:+998992600344', /(?:\+?998[\s()-]*)99[\s()-]*260[\s()-]*03[\s()-]*44/],
  ['phone:+998931244802', /(?:\+?998[\s()-]*)93[\s()-]*124[\s()-]*48[\s()-]*02/],
] as const

// Exact Telegram handles from reviewed external blacklists. User comments / "please
// check" submissions are deliberately excluded; only the editorial/list body is used.
const REPORTED_TELEGRAM_BY_SOURCE: Record<string, readonly string[]> = {
  moshelovka: [
    'pitupishka', 'obnalmanua1', 'p2p_lab_processing', 'hoodmoneyp2p', 'p2prvt',
    'protsessing', 'protsessing0', 'dropovod01k_chat', 'processing_skupka', 'mamonts',
    'brown_bear0', 'mediap2p', 'proseccina', 'amanatniy', 'pitupitradersrf',
    'russiantradersclubs', 'vvaybit',
  ],
  vklader: [
    'dobro_ot_yana', 'senpaj_help', 'shinobi_help', 'daime_helper', 'ninja_inform',
    'ninja_invest', 'assistent_ninja', 'alex_resolution', 'alex_crypto_way',
    'joecopytrade_bot', 'kirill_onchain', 'cryptolnspect', 'ghostl1', 'slashl1',
    'alexandrzenin', 'seriy_crypt', 'airolejon', 'olekitka', 'poizonrider',
    'poizonriderrobot', 'riderfeedback', 'poizonridersupport', 'poizondaniel',
    'poizonfenix', 'poizonsector', 'poizonlevel', 'poizonline', 'poizongo',
    'poizonoffice', 'poizonnation', 'poizonstorm', 'poizonsystem', 'poizonaura',
    'islyam_t', 'ethio_adam', 'vitalikadminn', 'ilya_vias', 'taddypedy', 'happyroman',
    'maxhappyict', 'rrrrviprr_bot', 'artem1991v', 'samuray_new', 'gen_zemtsov',
    'shortist_owner', 'arbitrage_capital', 'vladimir_arbitrage', 'mkwaydq',
    'poslednii_chance', 'romantradee', 'white_voronbtc', 'white_crow_btc',
    'unilive_network', 'potokcash', 'cashflowfund', 'potokpoint', 'cash_potok',
    'cashflowtime', 'kate_559', 'capitalforward', 'allocation_ay', 'andraicrypto',
    'andraicrypto_manager', 'vladbelokrylov', 'mersedes1_1', 'vadim_hub', 'david_gg7',
    'konstantinpravda', 'marafondeadinrich_bot', 'maratwhale', 'marat_whale',
    'fadeev_trade', 'andreysrbrv', 'speculant_g', 'sniperusdt', 'ratner_official',
    'arthurratner', 'markglavnyy', 'savivoin', 'l1r1q', 'arturomega', 'rodioncrypt0',
    'vipbyrodion_bot', 'magistr_tr', 'maxcrypto_adm', 'snipervip0001_bot', 'denis_longist',
    'alexeyaltador', 'anton_manag', 'twotradeowner', 'alexey_maker', 'alex_profitmaker',
    'hivetrader', 'robert_crypto98', 'neesmshnyi_bot', 'crypto_compass_btc', 'ska1pgod',
    'ternov_alexi', 'ternovhellobot', 'rafael_markov', 'cap_scalperr', 'dmitrukotov',
    'dmitrukot', 'crypto_partners_bot', 'learnarb_crypto', 'alinnainvest', 'speculyantt',
    'alex1trader', 'alexodessa_invest', 'alexodessa', 'maxbrotrd', 'mbro_pocket',
    'sergosnova', 'seedwalletshop_bot', 'seedpkultrasbot', 'arbitrageeproc', 'lebed_off',
    'cryptobotarbitrage_bot', 'youmentor_anna', 'kowalrenata', 'lunosupportstradebot',
    'nikicrypto_stre', 'exmonftmarket_bot', 'pr1vatee_roman', 'roman_pr1vat', 'rich_dmitry',
    'rudi_dmitry', 'sd_0986_bot', 'igor_richman', 'alex_wise_trade', 'alex_wiseman',
    'brokertribunai', 'tradelab_bot', 'tradelab_channel', 'tradelab_community',
    'superrare_thebot', 'traderr_server', 'trader_serverr', 'trader_servers',
    'traderer_stock', 'tanyamikheeva_pro_dengi', 'tanyamikheeva', 'veraastroguide',
    'daryu_money', 'mur_anastasi_official', 'dengisvoim_bot', 'minaevosnova',
    'pumpdumpcrypto_bot', 'trader_servver', 'traderr_serverl', 'maximonchain',
    'crypro_objectt', 'litvinov_teach', 'andrey_onchain', 'bank_tbx_bot', 'crypto_objectt',
  ],
}

const REPORTED_TELEGRAM_INVITES: readonly [string, string][] = [
  ['moshelovka:invite-hqnj', 't.me/+-hqnjkgsgha2zwm0'],
  ['moshelovka:invite-adhp', 't.me/+adhpbvvjddk2njfi'],
  ['vklader:penguin-protocol', 't.me/+jqffw2xgl04wytux'],
  ['vklader:velvethaze', 't.me/joinchat/57q3oqqv_ea2njhi'],
  ['vklader:pump', 't.me/+6ddntu5hsuo3ntmy'],
  ['vklader:bullvault', 't.me/joinchat/5ll_t_cthgbhytri'],
  ['vklader:lumencap', 't.me/joinchat/dbmlm5ieytezmwji'],
  ['vklader:cryptoosnova', 't.me/joinchat/zylzt2q8gmc1mjyy'],
]

const REPORTED_TELEGRAM_INDEX = (() => {
  const index = new Map<string, string[]>()
  for (const [source, handles] of Object.entries(REPORTED_TELEGRAM_BY_SOURCE)) {
    for (const handle of handles) {
      const key = handle.toLowerCase()
      const current = index.get(key) || []
      current.push(source)
      index.set(key, current)
    }
  }
  return index
})()

function reportedTelegramReasons(text: string): string[] {
  const reasons = new Set<string>()
  const handles = new Set<string>()
  for (const m of text.matchAll(/(?:^|[^a-z0-9_])@([a-z0-9_]{5,})/gi)) handles.add(m[1]!.toLowerCase())
  for (const m of text.matchAll(/(?:https?:\/\/)?t\.me\/([a-z0-9_]{5,})/gi)) handles.add(m[1]!.toLowerCase())

  for (const handle of handles) {
    for (const source of REPORTED_TELEGRAM_INDEX.get(handle) || []) {
      reasons.add(`${source}:${handle}`)
    }
  }

  const lower = text.toLowerCase()
  for (const [reason, fragment] of REPORTED_TELEGRAM_INVITES) {
    if (lower.includes(fragment)) reasons.add(reason)
  }
  return [...reasons]
}

// ---- Dating / romance-scam recruitment ------------------------------------
const DATING_AGENCY = /брачн(?:ое|ого|ом|ые|ых)\s+агентств|агентств[оа]\s+знакомств|шлюбн(?:е|ого|ому|і)\s+агентств|агенц(?:ія|ії)\s+знайомств|\bmarriage\s+agency\b|\bdating\s+agency\b/i
const DATING_CHAT_ROLE = /чат-?оператор|оператор\s+чат|оператор\s+переписк|менеджер\s+переписк|переводчик\s+(?:в|для)\s+(?:чат|переписк)|correspondence\s+(?:operator|manager)|chat\s+operator|dating\s+operator/i
const DATING_CHAT_SIGNAL = /переписк[а-яёіїєґ]*\s+от\s+лиц[ао]\s+(?:девуш|женщин|клиент)|вести\s+(?:женск[а-яёіїєґ]*\s+)?анкет|ведение\s+(?:женск[а-яёіїєґ]*\s+)?анкет|анкет[а-яёіїєґ]*\s+девуш|общени[а-яёіїєґ]*\s+с\s+(?:мужчин|иностранц)|спілкуван[а-яёіїєґ]*\s+з\s+(?:чоловік|іноземц)|листа[а-яёіїєґ]*\s+від\s+імені|писать\s+письма\s+(?:мужчинам|иностранцам)|подарк[а-яёіїєґ]*\s+от\s+(?:мужчин|клиент)|letters?\s+on\s+behalf\s+of|chat\s+on\s+behalf\s+of/i

// ---- Paid spam / microtask recruitment ------------------------------------
const PAID_MICROTASK = /оплат[а-яёіїєґ]*\s+(?:за\s+)?(?:кажд[а-яёіїєґ]*|одно|один)\s+(?:сообщени|лайк|комментари|пост|публикаци|рассылк|действи)|(?:платим|платят|заработок)\s+за\s+(?:сообщени|лайк|комментари|пост|публикаци|рассылк|действи)|оплата\s+за\s+(?:сообщени|лайк|комментари|пост|публикаци|рассылк|действи)|paid\s+per\s+(?:message|like|comment|post|task|action)|payment\s+per\s+(?:message|like|comment|post|task|action)/i
const MASS_SPAM_ACTION = /массов[а-яёіїєґ]*\s+рассылк|рассыл[а-яёіїєґ]*\s+(?:сообщени|текст|объявлен)|отправ[а-яёіїєґ]*\s+сообщени[а-яёіїєґ]*\s+(?:в|по)\s+(?:групп|чат)|размещ[а-яёіїєґ]*\s+(?:текст|сообщени|объявлен|пост)[а-яёіїєґ]*\s+(?:в|по)\s+(?:групп|чат)|публик[а-яёіїєґ]*\s+(?:в|по)\s+(?:групп|чат)|(?:facebook|telegram|whatsapp)\s+(?:groups?|chats?)|post\w*\s+(?:in|to)\s+(?:facebook|telegram|whatsapp)?\s*(?:groups?|chats?)/i
const SCREENSHOT_PROOF = /скриншот[а-яёіїєґ]*\s+(?:как\s+)?(?:подтверждени|отч[её]т|доказательств)|подтвержд[а-яёіїєґ]*\s+(?:выполнени[а-яёіїєґ]*\s+)?скриншот|присл[а-яёіїєґ]*\s+скриншот|screenshot\s+(?:as\s+)?(?:proof|confirmation|report)|send\s+(?:a\s+)?screenshot/i

// ---- Common fake-job schemes documented by T—Ж / Cyberpolice -------------
const PAY_TO_WORK = /(?:нужно|необходимо|потребуется|требуется|просим|перед\s+началом)[^.\n]{0,120}(?:оплатить|внести|перевести|пополнить)[^.\n]{0,120}(?:обучени|курс|страхов|доступ\s+к\s+(?:работ|задани)|активац|регистрац|подписк|софт|программ|оформлени|документ|взнос)|(?:платн[а-яёіїєґ]*\s+(?:обучени|стажировк|доступ\s+к\s+работ))[\s\S]{0,160}(?:до|перед|для)\s+(?:начал|допуск|работ)/i
const MARKETPLACE_BUYOUT = /(?:обратн[а-яёіїєґ]*\s+выкуп|выкуп(?:ать|ите|ить)?\s+(?:товар|заказ)|оплатить\s+(?:товар|заказ)|купить\s+товар\s+(?:для|чтобы)\s+(?:отзыв|задани))[\s\S]{0,240}(?:верн[её]м|возмест|возврат|комисс|процент|заработ)|(?:маркетплейс|ozon|wildberries|вайлдберриз|яндекс\s*маркет)[\s\S]{0,220}(?:выкуп|оплатить\s+товар)[\s\S]{0,180}(?:комисс|возврат|верн[её]м)/i
const MONEY_MULE = /(?:принимать|получать|зачислят)[^.\n]{0,120}(?:деньг|платеж|перевод)[^.\n]{0,120}(?:на\s+(?:свою|вашу(?:\s+личную)?|личную)\s+(?:карт|сч[её]т)|на\s+карту\s+сотрудник)[\s\S]{0,200}(?:переводить|пересылать|отправлять|распределять|снимать)[\s\S]{0,140}(?:%|процент|комисс|оплат)|(?:аренд[а-яёіїєґ]*\s+(?:карт|банковск[а-яёіїєґ]*\s+сч[её]т)|сдать\s+(?:карту|сч[её]т)\s+в\s+аренд)/i
const SIMPLE_TASK_DEPOSIT = /(?:лайк|отзыв|відгук|скриншот|брон(?:ировать|ювання)|просмотр[а-яёіїєґ]*\s+видео|прост[а-яёіїєґ]*\s+задани)[\s\S]{0,400}(?:внести|перевести|оплатить|пополнить)[^.\n]{0,120}(?:сумм|депозит|залог|баланс|товар|заказ|бронь|доступ)|(?:сначала|спочатку)[^.\n]{0,120}(?:платим|выплачиваем|винагород)[\s\S]{0,400}(?:потом|далее|потім)[^.\n]{0,160}(?:внести|перевести|оплатить|пополнить)/i
const BANK_SECRET_REQUEST = /(?:(?:пришл|сообщ|укаж|введ|отправ)[\s\S]{0,100})?(?:cvv|cvc|pin-?код|пін-?код|код\s+из\s+sms|код\s+з\s+sms|логин\s+и\s+пароль\s+(?:от|до)\s+(?:онлайн|интернет)[-\s]?банк|пароль\s+(?:от|до)\s+(?:онлайн|интернет)[-\s]?банк)(?:[\s\S]{0,100}(?:пришл|сообщ|укаж|введ|отправ))?/i

// ---- Existing scam/MLM templates ------------------------------------------
const INFOPRODUCT_RESELL = /перепродават[а-яёіїєґ]*\s+(?:наш[а-яёіїєґ]*\s+)?(?:курс|проект)|\brich\s*team\b|онлайн[-\s]?школ[а-яёіїєґ]*\s+RT\b|\bFRLNS\s*TEAM\b/i
const MLM_TEAM_COMMISSION = /созда(?:ть|вайте|ни[ея])[а-яёіїєґ\s]*команд[а-яёіїєґ]*[^.\n]{0,120}(?:процент|%)[^.\n]{0,80}(?:товарооборот|оборот)|(?:процент|%)[^.\n]{0,80}(?:товарооборот|оборот)[^.\n]{0,120}команд|партн[её]рск[а-яёіїєґ]*\s+(?:структур|команд)[а-яёіїєґ]*[^.\n]{0,100}(?:доход|заработ)/i
const VAGUE_REMOTE_EARNINGS = /научу\s+как\s+зарабат[а-яёіїєґ]*|научим\s+зарабат[а-яёіїєґ]*|зарабат[а-яёіїєґ]*\s+не\s+выходя\s+из\s+дома|желани[а-яёіїєґ]*\s+зарабат[а-яёіїєґ]*[^.\n]{0,100}(?:особых\s+навыков\s+не\s+требуется|опыт\s+не\s+нужен)/i
const VAGUE_REMOTE_PROFILE = /особых\s+навыков\s+(?:в\s+работе\s+)?не\s+требуется|без\s+опыта|опыт\s+не\s+нужен|(?:девушк|женщин)[а-яёіїєґ\s,]*(?:от\s+)?\d{2}[\s–—-]*(?:до\s+)?\d{2}|(?:ПК|компьютер)[^.\n]{0,80}(?:интернет|доступ\s+в\s+интернет)/i
const WELLNESS_NETWORK_PROJECT = /(?:женщин[а-яёіїєґ]*\s*30\+|женщин[а-яёіїєґ]*\s+в\s+декрет|мам[а-яёіїєґ]*\s+в\s+декрет)[\s\S]{0,500}(?:онлайн[-\s]?проект|сообществ[а-яёіїєґ]*\s+поддержк)[\s\S]{0,500}(?:здоровь|продукц[а-яёіїєґ]*\s+для\s+здоровь)[\s\S]{0,500}(?:доход|зарабат|бесплатн[а-яёіїєґ]*\s+обучени)/i

// ---- Vague crypto recruitment ---------------------------------------------
const CRYPTO_JOB_SIGNAL = /цифров(?:ые|ых|ыми)\s+актив|криптовалют(?:а|ы|е|ой|ные|ных|ными)|крипто-?актив|\bDEX\b|\bDeFi\b|digital\s+assets?|crypto(?:currency)?\s+(?:services?|assets?|operations?)/i
const VAGUE_CRYPTO_DUTIES = /работа\s+с\s+(?:предоставленн[а-яёіїєґ]*\s+)?информаци[а-яёіїєґ]*|работа\s+с\s+DEX-?инструмент[а-яёіїєґ]*|выполнени[а-яёіїєґ]*\s+(?:поставленных\s+)?задач\s+по\s+готов[а-яёіїєґ]*\s+алгоритм[а-яёіїєґ]*|использовани[а-яёіїєґ]*\s+(?:необходимых\s+)?криптовалютн[а-яёіїєґ]*\s+сервис[а-яёіїєґ]*(?:\s+(?:согласно|по)\s+(?:рабочим\s+)?инструкц[а-яёіїєґ]*)?|проверка\s+данных\s+и\s+статус[а-яёіїєґ]*\s+задач|сопровождени[а-яёіїєґ]*\s+(?:текущих\s+)?процесс[а-яёіїєґ]*|контроль\s+выполнени[а-яёіїєґ]*\s+(?:поставленных\s+)?задан[а-яёіїєґ]*|ведение\s+(?:внутренн[а-яёіїєґ]*\s+отч[её]тност|рабоч[а-яёіїєґ]*\s+данн[а-яёіїєґ]*)|соблюдени[а-яёіїєґ]*\s+инструкц[а-яёіїєґ]*|сопровожда(?:ть|ете|ете\s+их)[^.\n]{0,100}(?:операц|сделк)|следи(?:ть|те)[^.\n]{0,80}(?:параметр|операц|сделк)|готов[а-яёіїєґ]*\s+торгов[а-яёіїєґ]*\s+сигнал|working\s+with\s+(?:information|data)\s+(?:in|about)\s+(?:crypto|digital\s+assets)|follow(?:ing)?\s+(?:internal\s+)?instructions\s+for\s+crypto/i
const BEGINNER_TRAINING_BAIT = /без\s+опыта|опыт[а-яёіїєґ\s]*не\s+(?:является\s+)?обязател|бесплатн[а-яёіїєґ]*\s+обучени|обучени[а-яёіїєґ]*\s+с\s+нуля|помощ[а-яёіїєґ]*\s+наставник|поддержк[а-яёіїєґ]*\s+(?:наставник|после\s+обучения)|no\s+experience|free\s+training|training\s+from\s+scratch|mentor(?:ship)?\s+(?:provided|available)/i
const TELEGRAM_RECRUITMENT = /(?:обращаться|писать|контакт|подробност[а-яёіїєґ]*|связ[а-яёіїєґ]*)[^\n]{0,80}(?:telegram|телеграм)|(?:telegram|телеграм)[^\n]{0,80}(?:@?[a-z][a-z0-9_]{4,}|t\.me\/)/i

// ---- Foreign-employment scams / Uzbekistan licensing ----------------------
const FOREIGN_JOB_SIGNAL = /работ[а-яёіїєґ]*\s+(?:за\s+границ|за\s+кордон|за\s+рубеж)|трудоустройств[а-яёіїєґ]*\s+(?:за\s+границ|за\s+рубеж)|працевлаштуван[а-яёіїєґ]*\s+за\s+кордон|work\s+abroad|overseas\s+employment/i
const FOREIGN_EMPLOYMENT_INTERMEDIARY = /агентств[а-яёіїєґ]*\s+(?:по\s+)?(?:трудоустройств|занятост)|посредник[а-яёіїєґ]*\s+(?:по\s+)?трудоустройств|подбор\s+работ[а-яёіїєґ]*\s+за\s+(?:границ|рубеж)|помощ[а-яёіїєґ]*\s+(?:с\s+)?(?:трудоустройств|оформлени[а-яёіїєґ]*\s+(?:рабоч[а-яёіїєґ]*\s+)?виз)|employment\s+agency|recruitment\s+agency/i
const FOREIGN_JOB_UPFRONT_FEE = /(?:работ[а-яёіїєґ]*\s+(?:за\s+границ|за\s+кордон|за\s+рубеж)|трудоустройств[а-яёіїєґ]*\s+(?:за\s+границ|за\s+рубеж)|працевлаштуван[а-яёіїєґ]*\s+за\s+кордон)[\s\S]{0,600}(?:предоплат|внести|оплатить|перевести)[^.\n]{0,140}(?:виз|приглашени|запрошенн|документ|страхов|регистрац|бронь|гарантийн[а-яёіїєґ]*\s+взнос|услуг[а-яёіїєґ]*\s+агентств)/i

// Current licensed private employment agencies in Uzbekistan.
// Snapshot of the official Migration Agency register, updated there on 2026-08-08.
// Absence is a SOFT signal only; direct foreign employers are not intermediaries.
const UZ_LICENSED_FOREIGN_EMPLOYMENT_AGENCIES = [
  'reiwa', 'migo overseas consulting', 'turon world cooperation', 'specialist group',
  'naimix', 'common sense', 'dhaef global', 'job maker', 'the best-staff', 'mir power',
  'horizon work', 'world wide immigration', 'the kasb', 'best globalize',
  'gotalent international', 'globalhr', 'international migration line', 'work expert',
  'viza master', 'diamor', 'fairness japan', 'getwork', 'garant immigration',
  'youth globe', 'jobbridge', 'aimjob', 'worknet', 'gilen jobs', 'interwork', 'oukaway',
  'bestwill', 'world bridge', 'gate', 'immigration service', 'visacentrum',
  'resurs export group', 'imkon', 'trust migration', 'united careers', 'talantum group',
  'skd man power', 'qadam global', 'workline', 'meros job', 'hr job start',
  'mora work group', 'jobex',
] as const

function normalizeCompany(value: string): string {
  return value
    .toLowerCase()
    .replace(/[“”"'`«»]/g, ' ')
    .replace(/\b(?:ooo|mchj|llc|сп\s+ооо)\b/gi, ' ')
    .replace(/xususiy\s+bandlik\s+agentligi/gi, ' ')
    .replace(/private\s+employment\s+agency/gi, ' ')
    .replace(/[^a-z0-9а-яёіїєґ-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isLicensedUzForeignEmploymentAgency(company: string): boolean {
  const normalized = normalizeCompany(company)
  if (!normalized) return false
  return UZ_LICENSED_FOREIGN_EMPLOYMENT_AGENCIES.some((name) => normalized.includes(name))
}

// ---- Soft signals ----------------------------------------------------------
const HAS_DUTIES = /обязанност|обов'?язк|responsibilit|what\s+you(?:'|’)?ll\s+(?:do|be\s+doing)|задачи|завдання|duties|your\s+role|чем\s+предстоит\s+заниматься|функционал|job\s+description|требования\s+к\s+задачам/i
const HAS_PRODUCT = /продукт|product|платформ|сервис|сервіс|service|приложени|застосунок|\bapp\b|систем|клиентам\s+(?:банка|компании)|индустри|industry|проект|project/i
const VAGUE_TITLE = /^(?:менеджер|специалист|спеціаліст|сотрудник|співробітник|оператор|консультант|помощник|помічник|ассистент|manager|specialist|operator|assistant|consultant|employee|staff)$/i
const GENERIC_DUTY = /общение\s+с\s+клиентами|спілкування\s+з\s+клієнтами|работа\s+с\s+клиентами|communication\s+with\s+clients|прием\s+звонков|ответы\s+на\s+сообщения/i
const PROFESSIONAL_DUTY_ACTION = /\b(?:develop|deploy|maintain|analy[sz]e|prepare|identify|improve|build|integrate|support|design|implement|manage|monitor|optimi[sz]e|create|lead|test|review|coordinate|deliver)(?:s|ed|ing)?\b/gi
const EARNINGS_FOCUS = /(?:доход|заработок|заработная\s+плата|зарплата|дохід|заробіток|earnings|income)/gi
const WORK_WORDS = /(?:задач|обязанн|проект|разработ|клиент|продукт|команд|опыт|навык|обов|розроб|досвід|навич|task|project|develop|team|skill|experience)/gi

function testAll(rules: readonly (readonly [string, RegExp])[], text: string): string[] {
  const hits: string[] = []
  for (const [name, re] of rules) if (re.test(text)) hits.push(name)
  return hits
}

export function classifySuspicion(input: {
  title?: string
  company?: string
  description?: string
  salaryMin?: number
  salaryMax?: number
  salaryCurrency?: string
}): SuspicionResult {
  const title = (input.title || '').trim()
  const company = (input.company || '').trim()
  const description = (input.description || '').trim()
  const text = `${title}\n${company}\n${description}`

  const riskReasons: string[] = []
  let riskCategory: RiskCategory | null = null

  const gambling = testAll(GAMBLING, text)
  if (gambling.length) {
    riskCategory = 'gambling'
    riskReasons.push(...gambling.map((r) => `gambling:${r}`))
  }

  const adultStrong = testAll(ADULT_STRONG, text)
  const adultWeak = ADULT_WEAK.test(text) && ADULT_SIGNAL.test(text)
  if (adultStrong.length || adultWeak) {
    riskCategory = riskCategory || 'adult'
    riskReasons.push(...adultStrong.map((r) => `adult:${r}`))
    if (adultWeak) riskReasons.push('adult:role+explicit-signal')
  }

  const scam = testAll(SCAM, text)
  const scamContacts = testAll(SCAM_CONTACTS, text)
  const reportedScamTelegram = reportedTelegramReasons(text)
  const datingAgency = DATING_AGENCY.test(text)
  const datingChat = DATING_CHAT_ROLE.test(text) && DATING_CHAT_SIGNAL.test(text)
  const paidSpamTask = PAID_MICROTASK.test(text) && (MASS_SPAM_ACTION.test(text) || SCREENSHOT_PROOF.test(text))
  const payToWork = PAY_TO_WORK.test(text)
  const marketplaceBuyout = MARKETPLACE_BUYOUT.test(text)
  const moneyMule = MONEY_MULE.test(text)
  const simpleTaskDeposit = SIMPLE_TASK_DEPOSIT.test(text)
  const bankSecretRequest = BANK_SECRET_REQUEST.test(text)
  const foreignJobUpfrontFee = FOREIGN_JOB_UPFRONT_FEE.test(text)
  const infoproductResell = INFOPRODUCT_RESELL.test(text)
  const mlmTeamCommission = MLM_TEAM_COMMISSION.test(text)
  const vagueRemoteEarnings = VAGUE_REMOTE_EARNINGS.test(text)
    && VAGUE_REMOTE_PROFILE.test(text)
    && TELEGRAM_RECRUITMENT.test(text)
  const wellnessNetworkProject = WELLNESS_NETWORK_PROJECT.test(text)

  const cryptoTop = input.salaryMax ?? input.salaryMin
  const cryptoCurrency = String(input.salaryCurrency || '').toUpperCase()
  const highBeginnerCryptoPay = cryptoTop !== undefined
    && (((cryptoCurrency === 'EUR' || cryptoCurrency === 'USD') && cryptoTop >= 3000)
      || (cryptoCurrency === 'GBP' && cryptoTop >= 2500))
  const vagueCryptoRecruitment = CRYPTO_JOB_SIGNAL.test(text)
    && VAGUE_CRYPTO_DUTIES.test(text)
    && BEGINNER_TRAINING_BAIT.test(text)
    && (TELEGRAM_RECRUITMENT.test(text) || highBeginnerCryptoPay)

  if (
    scam.length
    || scamContacts.length
    || reportedScamTelegram.length
    || datingAgency
    || datingChat
    || paidSpamTask
    || payToWork
    || marketplaceBuyout
    || moneyMule
    || simpleTaskDeposit
    || bankSecretRequest
    || foreignJobUpfrontFee
    || infoproductResell
    || mlmTeamCommission
    || vagueRemoteEarnings
    || wellnessNetworkProject
    || vagueCryptoRecruitment
  ) {
    riskCategory = riskCategory || 'scam'
    riskReasons.push(...scam.map((r) => `scam:${r}`))
    riskReasons.push(...scamContacts.map((r) => `scam:known-contact:${r}`))
    riskReasons.push(...reportedScamTelegram.map((r) => `scam:reported-contact:${r}`))
    if (datingAgency) riskReasons.push('scam:dating-agency')
    if (datingChat) riskReasons.push('scam:dating-chat')
    if (paidSpamTask) riskReasons.push('scam:paid-spam-task')
    if (payToWork) riskReasons.push('scam:pay-to-work')
    if (marketplaceBuyout) riskReasons.push('scam:marketplace-buyout')
    if (moneyMule) riskReasons.push('scam:money-mule')
    if (simpleTaskDeposit) riskReasons.push('scam:simple-task-deposit')
    if (bankSecretRequest) riskReasons.push('scam:bank-credentials')
    if (foreignJobUpfrontFee) riskReasons.push('scam:foreign-job-upfront-fee')
    if (infoproductResell) riskReasons.push('scam:course-resell')
    if (mlmTeamCommission) riskReasons.push('scam:mlm-team-commission')
    if (vagueRemoteEarnings) riskReasons.push('scam:vague-remote-earnings')
    if (wellnessNetworkProject) riskReasons.push('scam:wellness-network-project')
    if (vagueCryptoRecruitment) riskReasons.push('scam:vague-crypto-recruitment')
  }

  const suspicionReasons: string[] = []
  const professionalDutyActions = description.match(PROFESSIONAL_DUTY_ACTION)?.length || 0
  // Direct-employer snippets frequently omit a "Responsibilities" heading but
  // still enumerate concrete work. Do not turn a truncated, substantive card
  // into two vagueness signals merely because that heading is absent.
  const hasDuties = HAS_DUTIES.test(text)
    || (description.length >= 140 && !VAGUE_TITLE.test(title) && professionalDutyActions >= 2)
  const longEnough = description.length >= 200

  if (!hasDuties && description.length < 400) suspicionReasons.push('no-responsibilities')
  if (VAGUE_TITLE.test(title)) suspicionReasons.push('vague-title')
  if (!hasDuties && GENERIC_DUTY.test(text)) suspicionReasons.push('generic-duties')
  if (!company || /^(?:компания|company|фирма|организация|работодатель|employer)$/i.test(company)) {
    suspicionReasons.push('unclear-employer')
  }
  if (longEnough && !HAS_PRODUCT.test(text)) suspicionReasons.push('no-product-description')

  // Uzbekistan: a local intermediary offering overseas employment should be in the
  // Migration Agency's licensed register. Missing match is warning-only because a
  // foreign employer may recruit directly and company names can be abbreviated.
  const uzLocalContext = /(?:\+?998(?:\D|$)|ташкент|tashkent|toshkent|узбекистан|uzbekistan|самарканд|samarkand)/i.test(text)
  const uzForeignIntermediary = uzLocalContext
    && FOREIGN_JOB_SIGNAL.test(text)
    && FOREIGN_EMPLOYMENT_INTERMEDIARY.test(text)
  if (uzForeignIntermediary && !isLicensedUzForeignEmploymentAgency(company)) {
    suspicionReasons.push('foreign-employment-license-unverified')
  }
  const normalizedCompany = normalizeCompany(company)
  if (uzForeignIntermediary && (normalizedCompany.includes('nps personal') || normalizedCompany === 'etos')) {
    suspicionReasons.push('foreign-employment-license-terminated')
  }

  const earnings = (text.match(EARNINGS_FOCUS) || []).length
  const work = (text.match(WORK_WORDS) || []).length
  if (earnings >= 3 && earnings > work) suspicionReasons.push('earnings-focused')

  const HIGH: Record<string, number> = { USD: 5000, EUR: 5000, GBP: 4000, PLN: 20000, UAH: 120000, KZT: 1500000, UZS: 40000000, RUB: 400000 }
  const cap = HIGH[String(input.salaryCurrency || '').toUpperCase()]
  const top = input.salaryMax ?? input.salaryMin
  if (cap && top && top >= cap && !hasDuties) suspicionReasons.push('high-salary-no-duties')

  return {
    riskCategory,
    riskReasons: [...new Set(riskReasons)],
    suspicious: suspicionReasons.length >= 2
      || suspicionReasons.includes('foreign-employment-license-unverified')
      || suspicionReasons.includes('foreign-employment-license-terminated')
      || riskCategory !== null,
    suspicionReasons: [...new Set(suspicionReasons)],
  }
}
