/** Returns the likely start of a neighbouring Careerist card before its marker. */
function neighbouringProfileStart(lines: string[], markerIndex: number): number {
  // Typical fragments are either:
  //   role, name, Город
  // or role, salary, name, Город.
  let start = Math.max(0, markerIndex - 2)
  const maybeSalary = lines[markerIndex - 2] || ''
  // JavaScript \b is ASCII-only and does not form a reliable boundary after
  // Cyrillic currency words such as "руб". Use an explicit Unicode boundary.
  if (/\d[\d\s.,]*\s*(?:руб|₽|сум|so['’ʻʼ‘`]?m|UZS|USD|\$|тенге|₸)(?=$|[^\p{L}\p{N}])/iu.test(maybeSalary)) {
    start = Math.max(0, markerIndex - 3)
  }
  return start
}

/** Removes listing pagination, appended neighbouring CVs and inline JavaScript. */
export function trimCareeristProfileText(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const technicalBoundary = lines.findIndex((line) => (
    /^Показать еще$/iu.test(line)
    || /^<!--/u.test(line)
    || /^\$\s*\(\s*document\s*\)/iu.test(line)
    || /^window\./iu.test(line)
  ))
  const sourceLines = lines.slice(0, technicalBoundary >= 0 ? technicalBoundary : undefined)

  // Careerist search fragments sometimes contain the beginning of the next CV
  // after the requested profile. The second literal "Город"/"Возраст" block is
  // a much safer boundary than trying to guess where the first work history ends.
  let cityBlocks = 0
  let ageBlocks = 0
  let dateBlocks = 0
  let nextProfileAt = -1
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index]!
    if (/^\d{1,2}\s+\p{L}+,\s+20\d{2}$/iu.test(line)) {
      dateBlocks += 1
      if (dateBlocks > 1) {
        nextProfileAt = index
        break
      }
    }
    if (/^город$/iu.test(line)) {
      cityBlocks += 1
      if (cityBlocks > 1) {
        nextProfileAt = neighbouringProfileStart(sourceLines, index)
        break
      }
    }
    if (/^возраст$/iu.test(line)) {
      ageBlocks += 1
      if (ageBlocks > 1) {
        nextProfileAt = neighbouringProfileStart(sourceLines, index)
        break
      }
    }
  }

  const profileLines = sourceLines.slice(0, nextProfileAt >= 0 ? nextProfileAt : undefined)
  const clean: string[] = []
  let keptDate = false
  for (let index = 0; index < profileLines.length; index += 1) {
    const line = profileLines[index]!
    if (/^(?:отправить приглашение|подробнее)$/iu.test(line)) continue
    if (/^\d{1,2}\s+\p{L}+,\s+20\d{2}$/iu.test(line)) {
      if (keptDate) continue
      keptDate = true
    }
    if (/^возраст$/iu.test(line) && /^0(?:\s|\()/u.test(profileLines[index + 1] || '')) {
      index += 1
      continue
    }
    clean.push(line)
  }
  return clean.join('\n').trim()
}

/** Careerist listings put the desired role immediately after their date. */
export function careeristRoleFromText(text: string): string | null {
  const lines = trimCareeristProfileText(text).split('\n').map((line) => line.trim()).filter(Boolean)
  const date = lines.findIndex((line) => /^\d{1,2}\s+\p{L}+,\s+20\d{2}$/iu.test(line))
  const role = date >= 0 ? lines[date + 1] : undefined
  if (!role || role.length > 180 || /^(?:город|возраст|опыт работы)$/iu.test(role)) return null
  return role
}
