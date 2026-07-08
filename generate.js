// Questo è il codice completo per api/generate.js
export default async function handler(req, res) {
  // Accettiamo solo richieste di tipo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { fileData, prompt } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "API Key mancante nelle impostazioni di Vercel" });
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { 
              inline_data: { 
                mime_type: "application/pdf", 
                data: fileData 
              } 
            }
          ]
        }]
      })
    });

    const data = await response.json();

    // Verifichiamo se Gemini ha restituito una risposta valida
    if (data.candidates && data.candidates[0].content.parts[0].text) {
      res.status(200).json({ text: data.candidates[0].content.parts[0].text });
    } else {
      throw new Error("Gemini non ha restituito testo. Controlla il formato del PDF.");
    }

  } catch (error) {
    console.error("Errore API:", error);
    res.status(500).json({ error: error.message });
  }
}
