import assert from 'node:assert/strict';
import { boot, FixtureNode as N, select } from './helpers/dom-fixture.mjs';
let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('PASS', name); } catch (err) { console.error('FAIL', name, err.stack); process.exitCode = 1; } }
const profile = { personal: { firstName: 'Test', lastName: 'Applicant' }, workAuth: { authorizedToWork: 'Yes', requireSponsorship: 'No' }, education: [{ school: 'Exact Test University' }, { school: 'Second Test College' }] };
function field(b, label, el, index = 0) { return { el, label, kind: b.M.fieldKind(el), index, rule: b.M.matchRule(el, label, b.rules) }; }
function plan(b, f, p = profile, responses = []) { b.app.state.session = { responses }; return b.app.planField(f, p, { reuseSavedResponses: true }); }

await test('CC-305 date formats and split fields use the current local date', () => {
  const b = boot(); const now = new Date(); const mm = String(now.getMonth() + 1).padStart(2,'0'), dd = String(now.getDate()).padStart(2,'0'), yyyy = String(now.getFullYear());
  for (const [attrs, label, expected] of [
    [{ placeholder: 'MM-DD-YYYY' }, 'Date', `${mm}-${dd}-${yyyy}`],
    [{ placeholder: 'DD/MM/YYYY' }, 'Date', `${dd}/${mm}/${yyyy}`],
    [{ placeholder: 'YYYY-MM-DD' }, 'Date', `${yyyy}-${mm}-${dd}`],
    [{ type: 'date' }, 'Date', `${yyyy}-${mm}-${dd}`],
    [{ placeholder: 'MM-DD-YYYY' }, 'MM-DD-YYYY', `${mm}-${dd}-${yyyy}`],
  ]) {
    const el = b.doc.body.appendChild(new N('input', attrs));
    const f = field(b, `${label} | Voluntary Self-Identification of Disability | Information to complete this form`, el);
    assert.equal(f.rule?.key, 'selfIdDate'); assert.equal(plan(b, f).value, expected);
    el.value = '01-01-2020'; assert.equal(plan(b, f).value, expected, 'old date must refresh');
  }
  const months = select(b.doc, ['Select', ...Array.from({length:12}, (_,i)=>String(i+1))], { 'aria-label': 'Month' });
  const f = field(b, 'Month | Voluntary Self-Identification of Disability', months);
  assert.equal(b.M.setSelectValue(months, plan(b,f).value, f.rule.options, f.label), true);
  assert.equal(months.value, String(now.getMonth()+1));
  const dob = field(b, 'Month | Date of Birth | Voluntary Self-Identification of Disability', new N('input'));
  assert.notEqual(dob.rule?.key, 'selfIdDate');

  const disclosure = b.doc.body.appendChild(new N('section', {'data-automation-id':'voluntaryDisclosures'}));
  disclosure.append(new N('h2', {}, 'Voluntary Disclosures - Disability Self Identification'));
  const bare = disclosure.appendChild(new N('input', {'aria-label':'Date'}));
  const bareField = field(b, 'Date', bare);
  assert.equal(bareField.rule?.key, 'selfIdDate', 'nearest Workday disclosure container must be recognized');
  assert.equal(plan(b, bareField).value, `${mm}-${dd}-${yyyy}`, 'bare CC-305 date defaults to MM-DD-YYYY');
});

await test('authorization spelling, booleans, polarity, and exact saved questions', () => {
  const b = boot();
  const cases = [
    ['Are you legally authorised to work in the UK?', 'Yes'],
    ['Are you NOT authorized to work?', 'No'],
    ['Are you able to work without employer sponsorship?', 'Yes'],
    ['Will you now or in the future require visa sponsorship?', 'No'],
    ['Do you have legal permission to work in this country?', 'Yes'],
    ['Are you lawfully eligible for employment?', 'Yes'],
    ['Will you require immigration assistance?', 'No'],
    ['Can you maintain work authorization without visa sponsorship?', 'Yes'],
    ['Do you NOT require sponsorship?', 'Yes'],
    ['Are you legally authorized to work? | Will you require sponsorship?', 'Yes'],
  ];
  for (const [question, answer] of cases) {
    const el = select(b.doc, ['Select', 'No', 'Yes'], { 'aria-label': question });
    assert.equal(plan(b, field(b,question,el)).value, answer, question);
  }
  const q = 'Are you legally authorized to work in Canada?';
  const f = field(b, q, select(b.doc,['Select','No','Yes'],{'aria-label':q}));
  assert.equal(plan(b,f,{workAuth:{authorizedToWork:false}}).value, 'No');
  assert.equal(plan(b,f,{workAuth:{workAuthType:'Not a citizen',visaStatus:'International student'}}).status,'skipped');
  assert.equal(plan(b,f,{workAuth:{}},[{question:q, answer:'No'}]).value,'No');
  assert.equal(plan(b,f,profile,[{question:q, answer:'No'}]).value,'Yes');
  assert.equal(plan(b,f,{workAuth:{}},[{question:q.replace('Canada','India'),answer:'Yes'}]).status,'skipped');
  assert.equal(plan(b,f,{workAuth:{}},[{question:q.replace('authorized','not authorized'),answer:'Yes'}]).status,'skipped');
  const visa = field(b, 'Work authorisation type', new N('input'));
  assert.equal(visa.rule?.key, 'visaStatus');
  assert.equal(plan(b, visa, {workAuth:{authorizedToWork:'Yes',workAuthType:'F-1 OPT'}}).value,'F-1 OPT');
  assert.notEqual(field(b,'Do you need financial sponsorship for education?',new N('input')).rule?.key,'requireSponsorship');
  const inverted = field(b, cases[2][0], new N('input'));
  assert.equal(plan(b,inverted,{workAuth:{requireSponsorship:'No'}}).status,'skipped','missing work permission must not be assumed');
});

await test('native choices reject opposite polarity, disabled options and unavailable sources', () => {
  const b=boot(); const auth=b.rules.find(r=>r.key==='authorizedToWork');
  const el=select(b.doc,['Select','Not authorized','Authorized']);
  assert.equal(b.M.setSelectValue(el,'Yes',auth.options,'Work authorization'),true); assert.equal(el.value,'Authorized');
  for (const [choices,want] of [
    [['Referral','Company Website'], ''],
    [['Referral','Other'], 'Other'],
    [['Job Portal','Other'], 'Job Portal'],
    [['Job Board','Social Media','Other'], 'Social Media'],
    [['Job Board','LinkedIn','Social Media','Other'],'LinkedIn'],
  ]) {
    const source=select(b.doc,['Select',...choices]);
    b.M.setSelectValue(source,'LinkedIn',{},'How did you hear about us?'); assert.equal(source.value,want);
  }
  const disabled=select(b.doc,['Select','LinkedIn','Job Boards']); disabled.options[1].disabled=true;
  b.M.setSelectValue(disabled,'LinkedIn',{},'Source'); assert.equal(disabled.value,'Job Boards');
});

await test('state always comes from profile and resolves full names, abbreviations and ISO codes', () => {
  const b=boot();
  const stateField=field(b,'State / Province',select(b.doc,['Select','TX','IL'],{'aria-label':'State / Province'}));
  const planned=plan(b,stateField,{personal:{state:'Illinois'}},[{question:'State / Province',answer:'Texas'}]);
  assert.equal(planned.value,'Illinois'); assert.equal(planned.source,'profile');
  assert.equal(b.M.setSelectValue(stateField.el,planned.value,stateField.rule.options,stateField.label),true);
  assert.equal(stateField.el.value,'IL');
  for (const [stored,option] of [['Karnataka','IN-KA'],['Ontario','ON'],['California','US-CA']]) {
    const el=select(b.doc,['Select',option],{'aria-label':'State'});
    assert.equal(b.M.setSelectValue(el,stored,{},'State'),true,`${stored} -> ${option}`);
    assert.equal(el.value,option);
  }
});

await test('school uses the correct profile row and falls back only when the profile is blank', () => {
  const b=boot(); const el=new N('input',{'aria-label':'School'}); b.doc.body.append(el);
  const saved=[{question:'School',answer:'Old University'}];
  assert.equal(plan(b,field(b,'School',el,0),profile,saved).value,'Exact Test University');
  assert.equal(plan(b,field(b,'School',el,1),profile,saved).value,'Second Test College');
  assert.equal(plan(b,field(b,'School',el),{education:[]},saved).value,'Old University');
  assert.equal(plan(b,field(b,'School',el),{education:[{school:'',institution:'Imported College'}]}).value,'Imported College');
  const f=field(b,'Are you the first in your family to attend university?',select(b.doc,['Select','Yes','No']));
  assert.notEqual(f.rule?.key,'school');
  const native=select(b.doc,['Select','Exact Test University - Online']);
  assert.equal(b.M.setSelectValue(native,'Exact Test University',{},'School'),false);
});

await test('consent statements stay separate in one fieldset and use actual Yes/No branches', () => {
  const b=boot(); const fs=b.doc.body.appendChild(new N('fieldset')); fs.append(new N('legend',{},'Application consent'));
  for (const text of ['I agree to the terms and conditions','I consent to the privacy policy']) {
    const el=fs.appendChild(new N('input',{type:'checkbox','aria-label':text}));
    const label=b.M.deriveLabel(el); const f=field(b,label,el);
    assert.equal(f.rule?.key,'applicationConsent',label);
    assert.equal(b.M.setCheckboxValue(el,plan(b,f).value,f.rule.options,f.label),true);
    assert.equal(el.checked,true);
  }
  const radio=select(b.doc,['Select','I do not agree','I agree']);
  const r=b.rules.find(r=>r.key==='applicationConsent');
  assert.equal(b.M.setSelectValue(radio,'Yes',r.options,'I agree'),true); assert.equal(radio.value,'I agree');
});

function sourceMenu(b, tree, {plainWorkdayPrompts=false}={}) {
  const el=b.doc.body.appendChild(new N('button',{'aria-haspopup':'listbox','aria-controls':'source-menu','aria-label':'How did you hear about us?'},'Select'));
  const menu=b.doc.body.appendChild(new N('div',{role:'listbox',id:'source-menu'}));
  let selected='';
  const render=(branch)=>{
    menu.replaceChildren();
    for(const [label,children] of Object.entries(branch)) {
      const option=new N('div',{role:'option',...(plainWorkdayPrompts
        ? {'data-automation-id':'promptOption'}
        : (children ? {'data-automation-id':'promptExpandableNode','aria-expanded':'false'} : {}))},label);
      option.addEventListener('click',()=>{if(children)render(children);else{selected=label;el.textContent=label;el.setAttribute('aria-expanded','false');menu.replaceChildren();}});
      menu.append(option);
    }
  };
  el.addEventListener('click',()=>{if(!menu.children.length){render(tree);el.setAttribute('aria-expanded','true');}else{menu.replaceChildren();el.setAttribute('aria-expanded','false');}});
  el.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.replaceChildren();el.setAttribute('aria-expanded','false');}});
  return {el,menu,selected:()=>selected};
}
await test('custom sources search multiple parents and three levels before falling back',async()=>{
  for(const [tree,want] of [
    [{'Social Media':{Facebook:null},'Job Boards':{Professional:{LinkedIn:null}},Referral:null},'LinkedIn'],
    [{'Social Media':null,'Job Board':{LinkedIn:null}},'LinkedIn'],
    [{'Social Media':null,'Job Board':null},'Social Media'],
    [{Referral:{Friends:null},Website:null,Other:null},'Other'],
  ]){
    const b=boot();const f=sourceMenu(b,tree); b.M.beginFillSession();
    const ok=await b.M.setComboboxValue(f.el,'LinkedIn',100,{},'How did you hear about us?');
    assert.equal(f.selected(),want); assert.equal(ok,Boolean(want));assert.equal(f.menu.children.length,0);
  }
});

await test('Workday promptOption categories are drilled even without aria-expanded',async()=>{
  const b=boot(); const f=sourceMenu(b,{
    'Social Media':{Facebook:null},
    'Job Portal':{'Professional Network':{LinkedIn:null}},
    Other:null,
  },{plainWorkdayPrompts:true});
  b.M.beginFillSession();
  assert.equal(await b.M.setComboboxValue(f.el,'LinkedIn',100,{},'How did you hear about us?'),true);
  assert.equal(f.selected(),'LinkedIn'); assert.equal(f.menu.children.length,0);
});

await test('recorded Workday category roots bypass Search and wait for async children',async()=>{
  const b=boot();
  const el=b.doc.body.appendChild(new N('button',{
    'aria-haspopup':'listbox','aria-controls':'slow-source-menu','aria-label':'How Did You Hear About Us?','aria-expanded':'false'
  },'Search'));
  const menu=b.doc.body.appendChild(new N('div',{role:'listbox',id:'slow-source-menu'}));
  const search=new N('input',{type:'search','aria-label':'Search'});
  let searchWrites=0,selected='';
  search.addEventListener('input',()=>{searchWrites++; menu.replaceChildren(search); setTimeout(renderRoot,900);});
  const choose=(label)=>{selected=label;el.textContent=label;el.setAttribute('aria-expanded','false');menu.replaceChildren();};
  const renderChildren=()=>{
    menu.replaceChildren(search);
    const linkedIn=new N('div',{role:'option','data-automation-id':'promptOption'},'LinkedIn');
    linkedIn.addEventListener('click',()=>choose('LinkedIn'));
    menu.append(linkedIn);
  };
  const renderRoot=()=>{
    menu.replaceChildren(search);
    for(const [label,parent] of [['Campus Campaign',false],['Corporate Website',true],['Direct Source',true],['Job Board',true],['Online Recruiter',true],['Other',true],['Staffing Agency',true]]){
      // The recorded tenant exposes every row as promptOption even though the
      // UI paints arrows beside its parent categories.
      const option=new N('div',{role:'option','data-automation-id':'promptOption'},label);
      option.addEventListener('click',()=>{
        if(label==='Job Board'){menu.replaceChildren(search,new N('div',{'data-automation-id':'loading'},'Loading'));setTimeout(renderChildren,900);}
        else if(parent){menu.replaceChildren(search);setTimeout(()=>{const leaf=new N('div',{role:'option'},`${label} option`);leaf.addEventListener('click',()=>choose(`${label} option`));menu.append(leaf);},50);}
        else choose(label);
      });
      menu.append(option);
    }
  };
  el.addEventListener('click',()=>{if(!menu.children.length){renderRoot();el.setAttribute('aria-expanded','true');}else{menu.replaceChildren();el.setAttribute('aria-expanded','false');}});
  el.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.replaceChildren();el.setAttribute('aria-expanded','false');}});
  b.M.beginFillSession();
  assert.equal(await b.M.setComboboxValue(el,'LinkedIn',100,{},'How Did You Hear About Us?'),true);
  assert.equal(selected,'LinkedIn');
  assert.equal(searchWrites,0,'root Search must not be used when category arrows are present');
});

await test('extension and AI writes stay out of Pending until the applicant edits them',async()=>{
  const b=boot(); b.app.state.runId=1; b.app.state.adapter={key:'workday',quirks:{}};
  b.app.state.session={responses:[]};
  const source=select(b.doc,['Select','Social Media','Other'],{'aria-label':'How did you hear about us?'});
  const sf=field(b,'How did you hear about us?',source);
  b.app.state.allFields=[sf];
  assert.equal(await b.app.applyValue(sf,'LinkedIn',sf.rule),true);
  assert.equal(source.value,'Social Media');
  assert.equal(source.__zapplyWrittenValue,'Social Media','provenance must record the committed fallback');
  b.app.queueAnswersFromForm();
  assert.equal(b.sentMessages.some(m=>m.type==='ZAPPLY_HOLD_ANSWERS'),false,'extension fill must not be Pending');

  source.value='Other'; source.__zapplyUserEdited=true;
  assert.equal(b.app.recordAnswer(sf,{userDriven:true}),true);
  assert.equal(b.sentMessages.some(m=>m.type==='ZAPPLY_HOLD_ANSWERS'&&m.items?.[0]?.answer==='Other'),true);

  const ai=b.doc.body.appendChild(new N('textarea',{'aria-label':'Why are you interested?'}));
  const af=field(b,'Why are you interested?',ai); b.app.state.runId++;
  assert.equal(await b.app.applyValue(af,'AI draft answer',null),true);
  b.app.state.drafted.add(ai); ai.value='Applicant edited answer'; ai.__zapplyUserEdited=true;
  assert.equal(b.app.recordAnswer(af,{userDriven:true}),true,'edited AI answer must be Pending');
});

await test('searchable source menus wait for LinkedIn and do not let saved sources override it',async()=>{
  const b=boot();
  const el=b.doc.body.appendChild(new N('input',{role:'combobox','aria-label':'How did you hear about us?','aria-controls':'source-filter','aria-expanded':'false'}));
  const menu=b.doc.body.appendChild(new N('div',{role:'listbox',id:'source-filter'}));
  const render=(labels)=>{menu.replaceChildren();for(const text of labels){const opt=new N('div',{role:'option'},text);opt.addEventListener('click',()=>{el.value=text;el.setAttribute('aria-expanded','false');menu.replaceChildren();});menu.append(opt);}};
  el.addEventListener('click',()=>{el.setAttribute('aria-expanded','true');render(['Social Media','Job Board']);});
  el.addEventListener('input',()=>{if(el.value==='LinkedIn')setTimeout(()=>render(['LinkedIn']),250);else render(['Social Media','Job Board']);});
  el.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.replaceChildren();el.setAttribute('aria-expanded','false');}});
  const f=field(b,'How did you hear about us?',el);
  assert.equal(plan(b,f,profile,[{question:f.label,answer:'Indeed'}]).value,'LinkedIn');
  b.M.beginFillSession();
  assert.equal(await b.M.setComboboxValue(el,'LinkedIn',100,f.rule.options,f.label),true);
  assert.equal(el.value,'LinkedIn');assert.equal(menu.children.length,0);
});

function schoolPrompt(b,{missing=false,enterOnly=false,slow=false,freeEntry=false}={}) {
  const form=b.doc.body.appendChild(new N('form'));
  const wrapper=form.appendChild(new N('div',{'data-automation-id':'multiSelectContainer'}));
  const el=wrapper.appendChild(new N('input',{'aria-autocomplete':'list','aria-label':'School','aria-controls':'schools','aria-expanded':'false'}));
  const menu=wrapper.appendChild(new N('div',{role:'listbox',id:'schools'}));
  let submitted=0,selected='',clicks=0;
  const commit=()=>{selected='Exact Test University';el.value='';el.setAttribute('aria-expanded','false');menu.replaceChildren();wrapper.append(new N('span',{'data-automation-id':'selectedItem'},selected));};
  const options=()=>{
    menu.replaceChildren();
    if(missing)return;
    const opt=new N('div',{role:'option',id:'exact-school'},'Exact Test University');
    opt.addEventListener('click',()=>{clicks++;if(!enterOnly)commit();else el.setAttribute('aria-activedescendant','exact-school');});
    menu.append(opt);
  };
  el.addEventListener('click',()=>el.setAttribute('aria-expanded','true'));
  el.addEventListener('input',()=>{if(slow&&el.value==='Exact Test University')setTimeout(options,650);});
  el.addEventListener('keydown',e=>{
    if(e.key==='Escape'){menu.replaceChildren();el.setAttribute('aria-expanded','false');}
    if(e.key==='Enter'){
      if(enterOnly&&clicks)commit();
      else if(el.value==='Exact Test University'){ if(freeEntry)commit(); else if(!slow)options(); }
    }
  });
  form.addEventListener('submit',()=>submitted++);
  return {el,menu,selected:()=>selected,submitted:()=>submitted};
}
await test('school prompt searches with Enter and commits on the owning input',async()=>{
  for(const config of [{enterOnly:true},{slow:true},{freeEntry:true},{missing:true}]){
    const b=boot();const f=schoolPrompt(b,config); b.M.beginFillSession();
    assert.equal(b.M.fieldKind(f.el),'select');
    const ok=await b.M.setComboboxValue(f.el,'Exact Test University',100,{},'School');
    assert.equal(ok,!config.missing,JSON.stringify(config)); assert.equal(f.selected(),config.missing?'':'Exact Test University');
    assert.equal(f.menu.children.length,0);assert.equal(f.submitted(),0);
    if(config.missing){assert.equal(f.el.value,'');assert.equal(b.M.hasValue(f.el),false);}
  }
});
console.log(`${passed} requested-fix groups passed`);
