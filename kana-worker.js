// Runs the kuromoji dictionary off the main thread so the app never freezes while readings are made.
// Receives { id, names } and replies { id, readings } (katakana/as-is) or { id, error }.
const KUROMOJI = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/";
importScripts(KUROMOJI + "build/kuromoji.js");

let tokenizerP = null;
function getTokenizer(){
  if(!tokenizerP){
    tokenizerP = new Promise((res, rej) => {
      kuromoji.builder({ dicPath: KUROMOJI + "dict/" }).build((err, t) => err ? rej(err) : res(t));
    });
  }
  return tokenizerP;
}

onmessage = async e => {
  const { id, names } = e.data;
  try{
    const t = await getTokenizer();
    const readings = names.map(n => t.tokenize(n).map(x => x.reading && x.reading !== "*" ? x.reading : x.surface_form).join(""));
    postMessage({ id, readings });
  }catch(err){
    postMessage({ id, error: String(err && err.message || err) });
  }
};
