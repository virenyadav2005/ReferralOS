const fieldNames = ['title','companyName','location','experience','employmentType','workArrangement','skills','qualifications','description','requisitionId','salaryRange','applicationUrl','referralUrl','referralInstructions','deadline'];

export function createScreenshotExtractor(config,{fetchImpl=fetch}={}){
  return {
    configured:Boolean(config.screenshotOcrUrl&&config.screenshotOcrApiKey),
    async extract(images){
      if(!config.screenshotOcrUrl||!config.screenshotOcrApiKey)throw new Error('SCREENSHOT_OCR_NOT_CONFIGURED');
      let endpoint;
      try{endpoint=new URL(config.screenshotOcrUrl);}catch{throw new Error('SCREENSHOT_OCR_INVALID_CONFIGURATION');}
      if(!['https:','http:'].includes(endpoint.protocol)||(config.nodeEnv==='production'&&endpoint.protocol!=='https:'))throw new Error('SCREENSHOT_OCR_INVALID_CONFIGURATION');
      let response;
      try{
        response=await fetchImpl(endpoint,{method:'POST',headers:{authorization:`Bearer ${config.screenshotOcrApiKey}`,'content-type':'application/json'},body:JSON.stringify({instruction:'Extract only visible job-opening information. Do not infer missing values. Return JSON {fields:{fieldName:{value:string|null,confidence:number,sourceText:string|null}}}. Do not extract personal contact information unrelated to the job.',images:images.map(({mimeType,buffer})=>({mimeType,base64:buffer.toString('base64')}))})});
      }catch{throw new Error('SCREENSHOT_OCR_PROVIDER_FAILED');}
      if(!response.ok)throw new Error('SCREENSHOT_OCR_PROVIDER_FAILED');
      let payload;try{payload=await response.json();}catch{throw new Error('SCREENSHOT_OCR_INVALID_RESPONSE');}
      if(!payload||!payload.fields||typeof payload.fields!=='object')throw new Error('SCREENSHOT_OCR_INVALID_RESPONSE');
      const fields={};
      for(const name of fieldNames){const item=payload.fields[name];if(!item||typeof item!=='object') {fields[name]={value:null,confidence:0,sourceText:null,uncertain:true};continue;}
        const value=typeof item.value==='string'?item.value.slice(0,8000):null;
        const confidence=Number.isFinite(item.confidence)?Math.min(1,Math.max(0,Number(item.confidence))):0;
        fields[name]={value,confidence,sourceText:typeof item.sourceText==='string'?item.sourceText.slice(0,1000):null,uncertain:confidence<0.75||!value};
      }
      return {fields,provider:'configured-ocr'};
    },
  };
}
