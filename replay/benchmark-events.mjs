const events=new Set(['key_start','key_success','key_failure','key_reused','key_request_merged',
  'copy_success','copy_failure','refresh_requested','url_scrap_success','url_scrap_failure']);
const codes=new Set(['OK','SESSION_EXPIRED','SUBSCRIPTION_REQUIRED','ACCESS_DENIED','RATE_LIMITED',
  'SESSION_REQUIRED','UPSTREAM_ERROR','REQUEST_FAILED','INVALID_RESPONSE','NETWORK_ERROR','LOCAL_STORAGE_ERROR','CLIENT_ERROR','CLIPBOARD_DENIED']);
export function benchmarkEvent(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['event','code','status'].includes(key))||
    !events.has(value.event)||!codes.has(value.code))return null;
  if(value.status!==undefined&&(!Number.isInteger(value.status)||value.status<100||value.status>599))return null;
  return{event:value.event,code:value.code,...(value.status!==undefined?{status:value.status}:{})};
}
