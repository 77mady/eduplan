// api/generate.js
//
// Funzione serverless per Vercel: riceve le richieste dalla web app, tiene la
// chiave Gemini nascosta e la usa per generare testo. Include:
//  - cambio automatico di modello se il primo è troppo occupato
//  - nuovi tentativi automatici sugli errori temporanei ("alta richiesta")
//  - un tempo limite complessivo pensato per restare sotto il limite di
//    esecuzione delle funzioni Vercel (60s sul piano Hobby)
//  - continuazione automatica se la risposta viene troncata

const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash"
];
const MAX_CONTINUATIONS = 3;         // quante volte, al massimo, chiedere "continua"
const MAX_RETRIES_PER_MODEL = 2;     // nuovi tentativi per ciascun modello prima di passare al successivo
const RETRY_DELAY_MS = 3000;
const PER_CALL_TIMEOUT_MS = 45000;
const OVERALL_BUDGET_MS = 50000;     // tempo massimo totale (sotto il limite di 60s di Vercel)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Riconosce gli errori "temporanei" (vale la pena riprovare) da quelli definitivi
function isTransient(status, message) {
  const m = (message || '').toLowerCase();
  return status === 429 || status === 503 || status === 500 ||
    m.includes('overloaded') || m.includes('high demand') || m.includes('unavailable') || m.includes('quota');
}

module.exports = async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    res.status(500).json({
      error: "La variabile GEMINI_API_KEY non è configurata su Vercel. Vai su Project Settings → Environment Variables (ricordati di spuntare anche 'Production'), aggiungila, poi rifai il deploy (Deployments → ⋯ → Redeploy)."
    });
    return;
  }

  // Richiesta GET → usata dal pulsante "Testa connessione"
  if (req.method === 'GET') {
    try {
      const testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      const r = await fetch(testUrl);
      const d = await r.json();
      if (!r.ok) {
        res.status(502).json({ error: (d.error && d.error.message) || ('Errore ' + r.status) });
        return;
      }
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: 'Il server non riesce a raggiungere Gemini: ' + e.message });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metodo non consentito.' });
    return;
  }

  const { systemInstruction, userText, maxOutputTokens } = req.body || {};
  if (!userText || !String(userText).trim()) {
    res.status(400).json({ error: 'Testo della richiesta mancante.' });
    return;
  }

  const tokensPerCall = Math.max(256, Math.min(Number(maxOutputTokens) || 3000, 8192));
  const deadline = Date.now() + OVERALL_BUDGET_MS;

  try {
    const text = await generateWithContinuation(apiKey, systemInstruction, userText, tokensPerCall, deadline);
    res.status(200).json({ text });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};

// Un singolo tentativo di chiamata a un determinato modello, con timeout
async function callModelOnce(apiKey, model, body, deadline) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const remaining = deadline - Date.now();
  const perCallTimeout = Math.max(3000, Math.min(PER_CALL_TIMEOUT_MS, remaining));
  const timer = setTimeout(() => controller.abort(), perCallTimeout);

  try {
    const apiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);

    let data;
    try {
      data = await apiRes.json();
    } catch (e) {
      throw { transient: true, message: 'Risposta non valida dal server (' + apiRes.status + ').' };
    }

    if (!apiRes.ok) {
      const message = (data && data.error && data.error.message) || ('Errore ' + apiRes.status);
      throw { transient: isTransient(apiRes.status, message), message };
    }
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw { transient: true, message: 'Google non ha risposto in tempo (timeout).' };
    }
    if (err && typeof err.transient === 'boolean') throw err;
    throw { transient: true, message: (err && err.message) || 'Errore di rete.' };
  }
}

// Prova i modelli in ordine, con nuovi tentativi su ciascuno, rispettando il tempo limite complessivo.
// Qualsiasi errore (temporaneo o definitivo, es. modello non più disponibile) fa passare al modello
// successivo della lista, invece di interrompere subito tutto il processo.
async function callGeminiWithFallback(apiKey, body, deadline) {
  let lastMessage = '';
  for (const model of MODELS) {
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      if (Date.now() >= deadline) {
        throw new Error("I server di Google sono momentaneamente molto occupati e non hanno risposto in tempo utile. Riprova tra qualche minuto. Dettaglio: " + lastMessage);
      }
      try {
        return await callModelOnce(apiKey, model, body, deadline);
      } catch (err) {
        lastMessage = err.message;
        if (!err.transient) {
          // Errore specifico di questo modello (es. non più disponibile): passa al modello successivo
          break;
        }
        if (Date.now() + RETRY_DELAY_MS >= deadline) break; // niente tempo per un altro tentativo su questo modello
        await sleep(RETRY_DELAY_MS);
      }
    }
    // si passa al modello successivo della lista
  }
  throw new Error("C'è momentaneamente molta richiesta sui server di Google, oppure i modelli configurati non sono al momento disponibili. Ho provato tutti i modelli previsti senza successo: riprova tra qualche minuto. Dettaglio tecnico: " + lastMessage);
}

async function generateWithContinuation(apiKey, systemInstruction, userText, tokensPerCall, deadline) {
  let contents = [{ role: 'user', parts: [{ text: userText }] }];
  let fullText = '';

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    if (Date.now() >= deadline) {
      if (fullText.trim()) break; // meglio restituire quanto ottenuto finora che fallire del tutto
      throw new Error('Tempo scaduto prima di ricevere una risposta da Google. Riprova.');
    }

    const body = {
      contents,
      generationConfig: { temperature: 0.6, maxOutputTokens: tokensPerCall }
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const data = await callGeminiWithFallback(apiKey, body, deadline);

    if (data.promptFeedback && data.promptFeedback.blockReason) {
      throw new Error('Richiesta bloccata dal filtro di sicurezza di Gemini: ' + data.promptFeedback.blockReason);
    }
    const cand = data.candidates && data.candidates[0];
    if (!cand) throw new Error('Nessuna risposta generata da Gemini.');

    const chunk = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
    fullText += chunk;

    if (cand.finishReason !== 'MAX_TOKENS') break;
    if (i === MAX_CONTINUATIONS) break;

    contents.push({ role: 'model', parts: [{ text: chunk }] });
    contents.push({ role: 'user', parts: [{ text: 'Continua esattamente da dove ti sei interrotto, senza ripetere quanto già scritto e senza aggiungere premesse.' }] });
  }

  const finalText = fullText.trim();
  if (!finalText) throw new Error('Gemini ha restituito una risposta vuota.');
  return finalText;
}
