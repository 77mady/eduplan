export async function onRequestPost(context) {
  const { request, env } = context;
  const { fileData, prompt } = await request.json();
  const apiKey = env.GEMINI_API_KEY;

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
    
    // Controlliamo se Gemini ha risposto correttamente
    if (data.candidates && data.candidates[0].content.parts[0].text) {
      return new Response(JSON.stringify({ text: data.candidates[0].content.parts[0].text }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      throw new Error("Risposta non valida da Gemini");
    }
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
