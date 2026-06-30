"use strict";

function buildGeminiUrl(config) {
  const modelName = String(config.model || "").startsWith("models/")
    ? config.model
    : `models/${config.model}`;
  const encodedModel = modelName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${config.apiBaseUrl}/${encodedModel}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
}

function parseTimeToMinute(value) {
  const [hour, minute] = String(value || "").split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }

  return hour * 60 + minute;
}

function parsePeriodMinutes(period) {
  if (Number.isInteger(period.startMin) && Number.isInteger(period.endMin)) {
    return {
      startMin: period.startMin,
      endMin: period.endMin
    };
  }

  const [startText, endText] = String(period.time || "").split(" - ");
  const startMin = parseTimeToMinute(startText);
  const endMin = parseTimeToMinute(endText);

  return {
    startMin,
    endMin
  };
}

function normalizePeriodForPrompt(period) {
  const { startMin, endMin } = parsePeriodMinutes(period);

  return {
    state: period.state || period.status,
    startMin,
    endMin
  };
}

function normalizeSegmentsForGemini(state, day = "today") {
  const periods = state?.[day]?.timePeriods;
  if (!Array.isArray(periods)) {
    return [];
  }

  return periods.map(normalizePeriodForPrompt);
}

function normalizeOutagesForGemini(state, day = "today") {
  return normalizeSegmentsForGemini(state, day)
    .filter((period) => period.state === 2)
    .map(({ startMin, endMin }) => ({ startMin, endMin }));
}

function hasScheduleChanged(previousState, currentState, day) {
  return (
    JSON.stringify(normalizeSegmentsForGemini(previousState, day)) !==
    JSON.stringify(normalizeSegmentsForGemini(currentState, day))
  );
}

function selectScheduleForGemini(previousState, currentState) {
  if (hasScheduleChanged(previousState, currentState, "today")) {
    return {
      day: "today",
      oldSchedule: normalizeSegmentsForGemini(previousState, "today"),
      newSchedule: normalizeSegmentsForGemini(currentState, "today"),
      oldOutages: normalizeOutagesForGemini(previousState, "today"),
      newOutages: normalizeOutagesForGemini(currentState, "today"),
      currentMinute: currentState.currentMinute
    };
  }

  return {
    day: "tomorrow",
    oldSchedule: normalizeSegmentsForGemini(previousState, "tomorrow"),
    newSchedule: normalizeSegmentsForGemini(currentState, "tomorrow"),
    oldOutages: normalizeOutagesForGemini(previousState, "tomorrow"),
    newOutages: normalizeOutagesForGemini(currentState, "tomorrow"),
    currentMinute: null
  };
}

function formatCurrentMinute(currentMinute) {
  return Number.isInteger(currentMinute) ? String(currentMinute) : "не переданий";
}

function buildGeminiPrompt(previousState, currentState) {
  const selected = selectScheduleForGemini(previousState, currentState);

  return [
    "Ти аналізуєш зміни у графіку відключень електроенергії.",
    "",
    "Я дам тобі:",
    "1. OLD_SCHEDULE — попередній збережений графік.",
    "2. NEW_SCHEDULE — актуальний новий графік.",
    "3. OLD_OUTAGES — попередні періоди без світла, тобто тільки сегменти state=2.",
    "4. NEW_OUTAGES — нові періоди без світла, тобто тільки сегменти state=2.",
    "5. CURRENT_MINUTE — поточний час у хвилинах від початку доби. Якщо CURRENT_MINUTE не переданий, аналізуй всю добу.",
    "",
    "Кожен графік — це масив сегментів доби.",
    "",
    "Формат сегмента:",
    "",
    "{",
    '  "state": number,',
    '  "startMin": number,',
    '  "endMin": number',
    "}",
    "",
    "Пояснення станів:",
    "- state = 1 — світло є",
    "- state = 2 — світла нема",
    "- state = 3 — перемикання / перехідний період, коли світло зазвичай зʼявляється",
    "",
    "Ключове правило про state=3:",
    "- state=3 завжди є технічним 30-хвилинним періодом перемикання після відключення.",
    "- Не показуй state=3 як окрему зміну у відповіді.",
    "- Не формулюй зміни як 'було перемикання, стало...' або 'стало перемикання'.",
    "- Якщо різниця зачіпає state=3, пояснюй її тільки через те, що період відключення state=2 збільшився або зменшився.",
    "- Для висновку орієнтуйся насамперед на OLD_OUTAGES і NEW_OUTAGES.",
    "",
    "Пояснення часу:",
    "- startMin і endMin — хвилини від початку доби",
    "- 00:00 = 0",
    "- 00:30 = 30",
    "- 01:00 = 60",
    "- 24:00 = 1440",
    "- доба поділена на 48 слотів по 30 хвилин",
    "",
    "Твоє завдання:",
    "1. Порівняти OLD_OUTAGES і NEW_OUTAGES як основне джерело правди про зміни.",
    "2. Використовувати OLD_SCHEDULE і NEW_SCHEDULE тільки як додатковий контекст.",
    "3. Знайти всі проміжки часу, де змінився саме період без світла state=2.",
    "4. Обʼєднати сусідні 30-хвилинні проміжки, якщо там однакова зміна: відключення додалось або відключення прибралось.",
    "5. Якщо CURRENT_MINUTE переданий — ігнорувати зміни, які повністю закінчилися до CURRENT_MINUTE.",
    "6. Якщо зміна частково перетинається з CURRENT_MINUTE — показати тільки частину від CURRENT_MINUTE до кінця зміни.",
    "7. Пояснити зміни українською мовою у зручному для людини форматі.",
    "8. Не показувати JSON, індекси або технічні деталі.",
    '9. Якщо релевантних змін немає — відповісти: "Актуальних змін у графіку не знайдено."',
    "",
    "Формат відповіді:",
    "",
    "Оновлення графіка:",
    "- З HH:MM до HH:MM ...",
    "",
    "Приклади формулювань:",
    "",
    'Відключення додалось: "З HH:MM до HH:MM раніше було світло, тепер його не буде."',
    'Відключення прибралось: "З HH:MM до HH:MM раніше мало не бути світла, тепер світло буде."',
    'Відключення стало довшим: "Відключення збільшилось: з HH:MM до HH:MM тепер світла не буде."',
    'Відключення стало коротшим: "Відключення зменшилось: з HH:MM до HH:MM тепер світло буде."',
    "",
    "Важливі правила:",
    "- Не вигадуй змін, яких немає.",
    "- Не аналізуй причину зміни графіка.",
    "- Не давай порад.",
    "- Не згадуй період перемикання у відповіді.",
    "- Не використовуй слово 'перемикання' у відповіді.",
    "- Не описуй зміни state=3 напряму.",
    '- Не використовуй слова "можливо", "ймовірно", "схоже", якщо зміна прямо видно з даних.',
    '- "24:00" залишай як "24:00".',
    "- Відповідь має бути короткою і тільки про зміни.",
    "- Якщо змін багато, згрупуй їх максимально компактно, але без втрати змісту.",
    selected.day === "tomorrow"
      ? "- OLD_SCHEDULE і NEW_SCHEDULE нижче стосуються завтрашнього дня, тому CURRENT_MINUTE не переданий."
      : "- OLD_SCHEDULE і NEW_SCHEDULE нижче стосуються сьогоднішнього дня.",
    "",
    "OLD_SCHEDULE:",
    JSON.stringify(selected.oldSchedule),
    "",
    "NEW_SCHEDULE:",
    JSON.stringify(selected.newSchedule),
    "",
    "OLD_OUTAGES:",
    JSON.stringify(selected.oldOutages),
    "",
    "NEW_OUTAGES:",
    JSON.stringify(selected.newOutages),
    "",
    "CURRENT_MINUTE:",
    formatCurrentMinute(selected.currentMinute)
  ].join("\n");
}

function extractGeminiText(responseBody) {
  const parts = responseBody?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => part && part.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function describeLightScheduleChange(config, previousState, currentState, deps) {
  const response = await deps.requestWithRetry({
    method: "POST",
    url: buildGeminiUrl(config),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "alerts-tg-bot/1.0"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: buildGeminiPrompt(previousState, currentState) }]
        }
      ],
      generationConfig: {
        temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens
      }
    }),
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    retryBaseDelayMs: config.retryBaseDelayMs,
    responseType: "json",
    fetchImpl: deps.fetchImpl,
    logger: deps.logger
  });

  return extractGeminiText(response.body);
}

module.exports = {
  buildGeminiPrompt,
  buildGeminiUrl,
  describeLightScheduleChange,
  extractGeminiText,
  normalizePeriodForPrompt,
  normalizeOutagesForGemini,
  parsePeriodMinutes,
  normalizeSegmentsForGemini
};
