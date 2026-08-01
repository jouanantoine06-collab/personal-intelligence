// Les modèles ne respectent pas toujours une consigne "sans balise markdown" à la
// lettre (observé en conditions réelles avec Haiku, qui encapsule parfois sa
// réponse JSON dans ```json ... ``` malgré l'instruction contraire). Tout appelant
// qui demande une réponse JSON stricte à un modèle doit passer par cette fonction
// plutôt que JSON.parse directement, pour ne pas échouer silencieusement sur un
// JSON par ailleurs valide.
export function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}
