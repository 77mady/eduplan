// api/generate.js
// ===============================
// EduPlan AI Engine v2.0
// PARTE 1/3
// ===============================

const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash"
];

const DEFAULT_MODEL = MODELS[0];

const MAX_CONTINUATIONS = 5;
const MAX_RETRIES = 3;
const RETRY_DELAY = 3000;
const REQUEST_TIMEOUT = 60000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function translateError(message = "") {

  const msg = message.toLowerCase();

  if (msg.includes("high demand")) {
    return "I server di Gemini sono temporaneamente molto occupati. Sto riprovando automaticamente...";
  }

  if (msg.includes("quota")) {
    return "Hai esaurito la quota disponibile della tua API Gemini.";
  }

  if (msg.includes("api key")) {
    return "La chiave API Gemini non è valida.";
  }

  if (msg.includes("permission")) {
    return "La tua API non dispone dei permessi necessari.";
  }

  if (msg.includes("timeout")) {
    return "Tempo massimo di attesa superato.";
  }

  return message || "Errore sconosciuto.";
}

async function fetchWithTimeout(url, options) {

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT);

  try {

    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    clearTimeout(timeout);

    return response;

  } catch (err) {

    clearTimeout(timeout);

    throw err;

  }

}

async function callGemini(apiKey, body, preferredModel = DEFAULT_MODEL) {

  const orderedModels = [
    preferredModel,
    ...MODELS.filter(m => m !== preferredModel)
  ];

  let lastError = "";

  for (const model of orderedModels) {

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    for (let retry = 0; retry < MAX_RETRIES; retry++) {

      try {

        const response = await fetchWithTimeout(url, {

          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify(body)

        });

        const data = await response.json();

        if (response.ok) {

          return data;

        }

        lastError =
          data?.error?.message ||
          `Errore ${response.status}`;

        if (
          lastError.toLowerCase().includes("high demand")
        ) {

          await sleep(RETRY_DELAY);

          continue;

        }

        break;

      } catch (err) {

        lastError = err.message;

        await sleep(RETRY_DELAY);

      }

    }

  }

  throw new Error(
    translateError(lastError)
  );

}
