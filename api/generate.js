// api/generate.js
//
// Funzione serverless per Vercel: riceve le richieste dalla web app, tiene la
// chiave Gemini nascosta (letta da una variabile d'ambiente configurata su
// Vercel) e la usa per generare testo. Se la risposta viene troncata, chiede
// automaticamente di continuare finché il documento non è completo.
//
// Convenzione Vercel: un file in /api/generate.js risponde automaticamente
// all'indirizzo /api/generate.

const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash'
];

const DEFAULT_MODEL = MODELS[0];
const MAX_CONTINUATIONS = 3;
const MAX_RETRIES = 3;
const RETRY_DELAY = 3000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
module.exports = async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    res.status(500).json({
      error: "La variabile GEMINI_API_KEY non è configurata su Vercel. Vai su Project Settings → Environment Variables, aggiungila, poi rifai il deploy (Deployments → ⋯ → Redeploy)."
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

  const { systemInstruction, userText, maxOutputTokens, model } = req.body || {};
  if (!userText || !String(userText).trim()) {
    res.status(400).json({ error: 'Testo della richiesta mancante.' });
    return;
  }

  const chosenModel = model || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chosenModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const tokensPerCall = Math.max(256, Math.min(Number(maxOutputTokens) || 3000, 8192));

  try {
    const text = await generateWithContinuation(url, systemInstruction, userText, tokensPerCall);
    res.status(200).json({ text });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};

async function generateWithContinuation(url, systemInstruction, userText, tokensPerCall) {
  let contents = [{ role: 'user', parts: [{ text: userText }] }];
  let fullText = '';

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const body = {
      contents,
      generationConfig: { temperature: 0.6, maxOutputTokens: tokensPerCall }
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    let apiRes;
let data;
let lastError = '';

for (let modelIndex = 0; modelIndex < MODELS.length; modelIndex++) {

    const currentModel = MODELS[modelIndex];

    const currentUrl =
        `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${encodeURIComponent(apiKey)}`;

    for (let retry = 0; retry < MAX_RETRIES; retry++) {

        try {

            const controller = new AbortController();

            const timeout = setTimeout(() => controller.abort(),60000);

            apiRes = await fetch(currentUrl,{
                method:'POST',
                headers:{
                    'Content-Type':'application/json'
                },
                body:JSON.stringify(body),
                signal:controller.signal
            });

            clearTimeout(timeout);

            data = await apiRes.json();

            if(apiRes.ok){

                break;

            }

            const message =
                data?.error?.message || '';

            lastError = message;

            if(message.includes("high demand")){

                await sleep(RETRY_DELAY);

                continue;

            }

            throw new Error(message);

        }

        catch(err){

            lastError = err.message;

            if(retry < MAX_RETRIES-1){

                await sleep(RETRY_DELAY);

                continue;

            }

        }

    }

    if(apiRes?.ok){

        break;

    }

}

if(!apiRes?.ok){

    throw new Error(
        "I server di Google Gemini sono temporaneamente occupati. Riprova tra qualche minuto.\n\nDettaglio: "+lastError
    );

}
    try { data = await apiRes.json(); } catch (e) { throw new Error('Risposta non valida da Gemini (' + apiRes.status + ').'); }

    if (!apiRes.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('Errore Gemini ' + apiRes.status);
      throw new Error(msg);
    }
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
