export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  const { fileData, prompt } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "API Key mancante" });
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
            { inline_data: { mime_type: "application/pdf", data: fileData } }
          ]
        }]
      })
    });

    const data = await response.json();
    if (data.candidates && data.candidates[0].content.parts[0].text) {
      res.status(200).json({ text: data.candidates[0].content.parts[0].text });
    } else {
      res.status(500).json({ error: "Gemini non ha risposto correttamente" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
