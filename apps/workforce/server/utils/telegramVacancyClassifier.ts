const TELEGRAM_ROLE_RE = /\b(?:developer|engineer|designer|manager|analyst|consultant|specialist|associate|assistant|administrator|accountant|auditor|recruiter|copywriter|marketer|sales|support|operator|courier|driver|chef|waiter|qa|tester|devops|frontend|backend|android|ios)\b|разработ|инженер|дизайнер|менеджер|аналитик|консультант|специалист|ассистент|администратор|бухгалтер|аудитор|рекрутер|копирайтер|маркетолог|продав|кассир|оператор|курьер|водител|повар|официант|сварщик|электрик|mutaxassis|dasturchi|menejer|sotuv|haydovchi|oshpaz/iu

const TELEGRAM_PROMOTION_RE = /t\.me\/addlist\b|(?:telegram[- ]?)?канал\w*\s+(?:в\s+)?(?:одн\w+\s+)?папк|папк\w*\s+(?:telegram[- ]?)?канал|добав(?:ить|ьте|ляй)\s+(?:свой\s+)?канал\s+в\s+папк|добав(?:ить|ьте)\s+папк|до\s+закрытия\s+доступа|пока\s+ты\s+листаешь\s+ленту|лучшие\s+офферы\s+разлетаются|вакансии\s+сами\s+приходят|карьерн\w+\s+лайфхак/iu

/** Reject channel advertising/digests and keep posts describing a concrete opening. */
export function isLikelyTelegramVacancy(text: string): boolean {
  const value = text.replace(/\s+/g, ' ').trim()
  if (value.length < 20 || TELEGRAM_PROMOTION_RE.test(value)) return false

  const explicitPosition = /(?:vacancy|position|role|вакансия|позиция|посада|lavozim)\s*[:—-]\s*[\p{L}\p{N}]/iu.test(value)
  const hiringPhrase = /(?:we(?:'re| are)?\s+(?:hiring|looking\s+for)|ищем|требуется|шукаємо|потрібен|kerak)\s+(?:[\p{L}\p{N}][\p{L}\p{N}+.#/-]*\s*){1,8}/iu.test(value)
  const role = TELEGRAM_ROLE_RE.test(value)
  const requirements = /requirements?|responsibilit|qualifications?|обязанност|требован|условия|вазиф|талаб|міндет|талап/iu.test(value)
  const employment = /full[- ]?time|part[- ]?time|employment|график|занятост|офис|гибрид|удал[её]н|remote|ish vaqti|bandlik/iu.test(value)
  const application = /(?:apply|отклик|резюме|cv\b|hr\b|contact|контакт|мурожаат|bog['’]?lan)/iu.test(value)
  const concreteSalary = /\d[\d\s.,]*(?:USD|EUR|GBP|UAH|UZS|KZT|KGS|TJS|TMT|PLN|RON|[$€£₴₸]|сум|so['’]?m|тенге|тг\.?|сом|грн)/iu.test(value)

  if (explicitPosition || hiringPhrase) return role || requirements || employment || application || concreteSalary
  return role && [requirements, employment, application, concreteSalary].filter(Boolean).length >= 1
}
