// Fast path uses the native decoder. Diagnose malformed input using the legacy
// JSON grammar exposed by the reference HTTP protocol, rather than V8 wording.
export function parseJson(text) {
  try {return JSON.parse(text);} catch {}
  let position=0;
  const whitespace=()=>{while (/[ \r\n\t]/.test(text[position] || '\0')) position++;};
  const fail=(expected,at=position)=>{throw new Error(`Unexpected ${at>=text.length ? 'end-of-input' : JSON.stringify(text.slice(at))}, expecting ${expected}`);};
  const string=()=>{
    const start=position++;
    while(position<text.length) {
      const character=text[position++];
      if(character==='\\') {position++;continue;}
      if(character==='"') {try{JSON.parse(text.slice(start,position));return;}catch{throw new Error('Invalid string literal');}}
    }
    throw new Error('Unexpected end-of-input while parsing string literal');
  };
  const value=(depth=0)=>{
    if(depth>1000) throw new Error('Invalid JSON nesting');
    whitespace();
    const character=text[position];
    if(character==='"') {string();return;}
    if(character==='{') {
      position++;whitespace();
      if(text[position]==='}') {position++;return;}
      if(text[position]!=='"') fail('record key literal or }');
      while(true) {
        string();whitespace();
        if(text[position]!==':') fail(':');
        position++;value(depth+1);whitespace();
        if(text[position]==='}') {position++;return;}
        if(text[position]!==',') fail(', or }');
        const comma=position++;whitespace();
        if(text[position]!=='"') fail('key literal',comma);
      }
    }
    if(character==='[') {
      position++;whitespace();
      if(text[position]===']') {position++;return;}
      while(true) {
        value(depth+1);whitespace();
        if(text[position]===']') {position++;return;}
        if(text[position]!==',') fail(', or ]');
        position++;
      }
    }
    for(const token of ['true','false','null']) if(text.startsWith(token,position)) {position+=token.length;return;}
    const rest=text.slice(position);
    if(/^-?0\d/.test(rest)) throw new Error('Number literal with leading zero');
    const number=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if(number) {position+=number[0].length;return;}
    fail('JSON value');
  };
  value();whitespace();
  if(position<text.length) throw new Error('Trailing garbage');
  throw new Error('Invalid JSON');
}
