// functions/generate.js
//
// Cloudflare Pages Function: riceve le richieste dalla web app, tiene la
// chiave Gemini nascosta (letta da una variabile d'ambiente configurata su
// Cloudflare) e la usa per generare testo. Se la risposta viene troncata,
// chiede automaticamente di continuare finché il documento non è completo.
//
// Convenzione Cloudflare Pages: questo file, messo in /functions/generate.js
// nella cartella del sito, risponde automaticamente all'indirizzo /generate.

const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_CONTINUATIONS = 3;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Richiesta GET → usata dal pulsante "Testa connessione"
export async function onRequestGet({ env }) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: "La variabile GEMINI_API_KEY non è configurata su Cloudflare Pages. Vai su Settings → Environment variables, aggiungila, poi rifai il deploy." }, 500);
  }
  try {
    const testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const r = await fetch(testUrl);
    const d = await r.json();
    if (!r.ok) {
      return json({ error: (d.error && d.error.message) || ('Errore ' + r.status) }, 502);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: 'Il server non riesce a raggiungere Gemini: ' + e.message }, 502);
  }
}

// Richiesta POST → generazione vera e propria
export async function onRequestPost({ request, env }) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: "La variabile GEMINI_API_KEY non è configurata su Cloudflare Pages. Vai su Settings → Environment variables, aggiungila, poi rifai il deploy." }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ error: 'Corpo della richiesta non valido.' }, 400);
  }

  const { systemInstruction, userText, maxOutputTokens, model } = payload || {};
  if (!userText || !String(userText).trim()) {
    return json({ error: 'Testo della richiesta mancante.' }, 400);
  }

  const chosenModel = model || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chosenModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const tokensPerCall = Math.max(256, Math.min(Number(maxOutputTokens) || 3000, 8192));

  try {
    const text = await generateWithContinuation(url, systemInstruction, userText, tokensPerCall);
    return json({ text });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

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

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    let data;
    try { data = await res.json(); } catch (e) { throw new Error('Risposta non valida da Gemini (' + res.status + ').'); }

    if (!res.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('Errore Gemini ' + res.status);
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
