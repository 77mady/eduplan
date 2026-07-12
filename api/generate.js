// api/generate.js
//
// Funzione serverless per Vercel: riceve le richieste dalla web app, tiene le
// chiavi IA nascoste e genera testo con Gemini (predefinito) o Mistral
// (motore alternativo, a scelta dell'utente). Include cambio automatico di
// modello/nuovi tentativi su errori temporanei, un tempo limite complessivo
// pensato per restare sotto il limite di esecuzione di Vercel (60s sul piano
// Hobby), e continuazione automatica se la risposta viene troncata.

const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];
const MISTRAL_MODEL = 'open-mistral-nemo';

const MAX_CONTINUATIONS = 3;
const MAX_RETRIES_PER_MODEL = 1;
const RETRY_DELAY_MS = 2000;
const PER_CALL_TIMEOUT_MS = 32000;
const OVERALL_BUDGET_MS = 50000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransient(status, message) {
  const m = (message || '').toLowerCase();
  return status === 429 || status === 503 || status === 500 ||
    m.includes('overloaded') || m.includes('high demand') || m.includes('unavailable') || m.includes('quota') ||
    m.includes('rate limit');
}

module.exports = async (req, res) => {
  const provider = (req.method === 'GET' ? req.query.provider : (req.body && req.body.provider)) || 'gemini';
  const apiKey = provider === 'mistral' ? process.env.MISTRAL_API_KEY : process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const varName = provider === 'mistral' ? 'MISTRAL_API_KEY' : 'GEMINI_API_KEY';
    res.status(500).json({
      error: `La variabile ${varName} non è configurata su Vercel. Vai su Project Settings → Environment Variables (ricordati 'Production'), aggiungila, poi rifai il deploy (Deployments → ⋯ → Redeploy).`
    });
    return;
  }

  // Richiesta GET → usata dal pulsante "Testa connessione"
  if (req.method === 'GET') {
    try {
      if (provider === 'mistral') {
        const r = await fetch('https://api.mistral.ai/v1/models', { headers: { Authorization: 'Bearer ' + apiKey } });
        const d = await r.json();
        if (!r.ok) { res.status(502).json({ error: (d.error && d.error.message) || ('Errore ' + r.status) }); return; }
      } else {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
        const d = await r.json();
        if (!r.ok) { res.status(502).json({ error: (d.error && d.error.message) || ('Errore ' + r.status) }); return; }
      }
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: 'Il server non riesce a raggiungere ' + (provider === 'mistral' ? 'Mistral' : 'Gemini') + ': ' + e.message });
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
    const text = provider === 'mistral'
      ? await generateMistralWithContinuation(apiKey, systemInstruction, userText, tokensPerCall, deadline)
      : await generateGeminiWithContinuation(apiKey, systemInstruction, userText, tokensPerCall, deadline);
    res.status(200).json({ text });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};

/* =====================================================================
   GEMINI
   ===================================================================== */
async function callGeminiOnce(apiKey, model, body, deadline) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const remaining = deadline - Date.now();
  const perCallTimeout = Math.max(3000, Math.min(PER_CALL_TIMEOUT_MS, remaining));
  const timer = setTimeout(() => controller.abort(), perCallTimeout);

  try {
    const apiRes = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal
    });
    clearTimeout(timer);
    let data;
    try { data = await apiRes.json(); } catch (e) { throw { transient: true, message: 'Risposta non valida dal server (' + apiRes.status + ').' }; }
    if (!apiRes.ok) {
      const message = (data && data.error && data.error.message) || ('Errore ' + apiRes.status);
      throw { transient: isTransient(apiRes.status, message), message };
    }
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw { transient: true, message: 'Google non ha risposto in tempo (timeout).' };
    if (err && typeof err.transient === 'boolean') throw err;
    throw { transient: true, message: (err && err.message) || 'Errore di rete.' };
  }
}

async function callGeminiWithFallback(apiKey, body, deadline) {
  let lastMessage = '';
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      if (Date.now() >= deadline) {
        throw new Error("I server di Google sono momentaneamente molto occupati e non hanno risposto in tempo utile. Riprova tra qualche minuto. Dettaglio: " + lastMessage);
      }
      try {
        return await callGeminiOnce(apiKey, model, body, deadline);
      } catch (err) {
        lastMessage = err.message;
        if (!err.transient) break;
        if (Date.now() + RETRY_DELAY_MS >= deadline) break;
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw new Error("C'è momentaneamente molta richiesta sui server di Google, oppure i modelli configurati non sono al momento disponibili. Riprova tra qualche minuto. Dettaglio tecnico: " + lastMessage);
}

async function generateGeminiWithContinuation(apiKey, systemInstruction, userText, tokensPerCall, deadline) {
  let contents = [{ role: 'user', parts: [{ text: userText }] }];
  let fullText = '';

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    if (Date.now() >= deadline) {
      if (fullText.trim()) break;
      throw new Error('Tempo scaduto prima di ricevere una risposta da Google. Riprova.');
    }
    const body = { contents, generationConfig: { temperature: 0.6, maxOutputTokens: tokensPerCall } };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };

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

/* =====================================================================
   MISTRAL (API compatibile OpenAI: /v1/chat/completions)
   ===================================================================== */
async function callMistralOnce(apiKey, messages, tokensPerCall, deadline) {
  const controller = new AbortController();
  const remaining = deadline - Date.now();
  const perCallTimeout = Math.max(3000, Math.min(PER_CALL_TIMEOUT_MS, remaining));
  const timer = setTimeout(() => controller.abort(), perCallTimeout);

  try {
    const apiRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model: MISTRAL_MODEL, messages, max_tokens: tokensPerCall, temperature: 0.6 }),
      signal: controller.signal
    });
    clearTimeout(timer);
    let data;
    try { data = await apiRes.json(); } catch (e) { throw { transient: true, message: 'Risposta non valida dal server (' + apiRes.status + ').' }; }
    if (!apiRes.ok) {
      const message = (data && data.error && data.error.message) || ('Errore ' + apiRes.status);
      throw { transient: isTransient(apiRes.status, message), message };
    }
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw { transient: true, message: 'Mistral non ha risposto in tempo (timeout).' };
    if (err && typeof err.transient === 'boolean') throw err;
    throw { transient: true, message: (err && err.message) || 'Errore di rete.' };
  }
}

async function generateMistralWithContinuation(apiKey, systemInstruction, userText, tokensPerCall, deadline) {
  let messages = [];
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
  messages.push({ role: 'user', content: userText });

  let fullText = '';
  let lastMessage = '';

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    if (Date.now() >= deadline) {
      if (fullText.trim()) break;
      throw new Error('Tempo scaduto prima di ricevere una risposta da Mistral. Riprova.');
    }

    let data;
    let succeeded = false;
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      if (Date.now() >= deadline) break;
      try {
        data = await callMistralOnce(apiKey, messages, tokensPerCall, deadline);
        succeeded = true;
        break;
      } catch (err) {
        lastMessage = err.message;
        if (!err.transient) break;
        if (Date.now() + RETRY_DELAY_MS >= deadline) break;
        await sleep(RETRY_DELAY_MS);
      }
    }
    if (!succeeded) {
      if (fullText.trim()) break;
      throw new Error("C'è momentaneamente molta richiesta sui server di Mistral. Riprova tra qualche minuto. Dettaglio: " + lastMessage);
    }

    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error('Nessuna risposta generata da Mistral.');
    const chunk = (choice.message && choice.message.content) || '';
    fullText += chunk;

    if (choice.finish_reason !== 'length') break;
    if (i === MAX_CONTINUATIONS) break;

    messages.push({ role: 'assistant', content: chunk });
    messages.push({ role: 'user', content: 'Continua esattamente da dove ti sei interrotto, senza ripetere quanto già scritto e senza aggiungere premesse.' });
  }

  const finalText = fullText.trim();
  if (!finalText) throw new Error('Mistral ha restituito una risposta vuota.');
  return finalText;
}
