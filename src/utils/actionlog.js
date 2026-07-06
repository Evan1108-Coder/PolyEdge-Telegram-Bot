const MAX = 30;
const logs = new Map();
const ACKS = ['Got it — I’ll check the evidence.', 'On it — I’ll inspect before answering.', 'Working through it now.', 'I’ll verify that directly.', 'Understood — checking the actual state.'];

function id(chatId){ return String(chatId || 'global'); }
function remember(chatId, entry){
  const key=id(chatId); const arr=logs.get(key)||[];
  arr.push({ at:new Date().toISOString(), ...entry });
  logs.set(key, arr.slice(-MAX));
}
function recent(chatId, n=8){ return (logs.get(id(chatId))||[]).slice(-n); }
function ack(seed=''){
  let sum=0; for(const c of String(seed)) sum+=c.charCodeAt(0);
  return ACKS[sum % ACKS.length];
}
function evidenceSummary(chatId){
  const rows=recent(chatId,6);
  if(!rows.length) return 'No recent recorded actions in this chat yet.';
  return rows.map(r=>`- ${r.at}: ${r.action || 'action'}${r.evidence ? ` — ${r.evidence}` : ''}${r.result ? ` => ${r.result}` : ''}`).join('\n');
}
module.exports={remember,recent,ack,evidenceSummary};
