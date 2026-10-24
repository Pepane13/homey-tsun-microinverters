const Module=require('module');const _rf=Module._resolveFilename;Module._resolveFilename=function(r,...a){return r==='homey'?require('path').join(__dirname,'homey-mock.js'):_rf.call(this,r,...a)};
const path=require('path');const APP=process.env.APP||path.join(__dirname,'..','com.pepane13.tsun');process.env.APP=APP;
const {Device,_trig}=require('./homey-mock');const manifest=require(APP+'/app.json').drivers[0];
const SV=require(APP+'/lib/solarmanv5');const C0=SV.SolarmanV5Client;SV.SolarmanV5Client=class extends C0{constructor(o){super({...o,port:18899})}};
const D=require(APP+'/drivers/mx3000d/device.js');const {state,srv}=require('./fakelogger');
const ok=(c,m)=>console.log((c?'OK  ':'FAIL')+' '+m);
function setRegs({ac=2004,today=5.73,total=1321.1,pv=[348.7,359.7,348.7,346.2,373.1,344.1],pvDay=[.98,.97,1,1,1.06,.99],status=1,alarms=0,temp=113}){
 const r={};r[0x1100]=status;r[0x1105]=alarms;r[0x1106]=0;r[0x1200]=2365;r[0x1201]=847;r[0x1202]=Math.round(ac*10);r[0x1209]=5003;r[0x1210]=3000;
 r[0x1212]=Math.round(today*100);const t=Math.round(total*100);r[0x1213]=t>>16;r[0x1214]=t&0xffff;r[0x1218]=temp;
 pv.forEach((p,n)=>{const b=0x1302+7*n;r[b]=306;r[b+1]=1139;r[b+2]=Math.round(p*10);const dd=Math.round(pvDay[n]*100);r[b+3]=dd>>16;r[b+4]=dd&0xffff;r[b+5]=0;r[b+6]=21926});
 state.regs=r;}
(async()=>{
 await new Promise(r=>srv.listen(18899,'127.0.0.1',r));
 const d=new D(manifest,{host:'127.0.0.1',logger_sn:'1234567890',poll_interval:30,temp_offset:40,underperf_threshold:15,underperf_delay:15,underperf_min_power:80,underperf_mode:'simple'});
 // old capabilities to migrate
 d.caps['meter_power.today']=1;d.caps['measure_power.pv1']=1;d.caps.measure_temperature=20;d.caps.tsun_energy_today=1;d.caps.measure_voltage=230;d.caps['tsun_energy.total']=1;
 let day='2026-10-23';d._todayKey=()=>day;
 await d.onInit();
 ok(!['meter_power.today','measure_power.pv1','measure_temperature','tsun_energy_today','measure_voltage','tsun_energy.total'].some(c=>c in d.caps),'migration: obsolete capabilities removed');
 ok(manifest.capabilities.every(c=>c in d.caps),'migration: 22 capabilities present');
 setRegs({});await d._poll();
 ok(d.caps.measure_power===2004&&d.caps.meter_power===1321.1&&d.caps['tsun_energy.today']===5.73,'AC reading via fake logger: '+d.caps.measure_power+' W, '+d.caps.meter_power+' kWh, today '+d.caps['tsun_energy.today']);
 ok(d.caps['tsun_power.ac']===2004&&d.caps['tsun_voltage.grid']===236.5&&d.caps['tsun_current.grid']===8.47&&d.caps['tsun_frequency.grid']===50.03,'chart capabilities mirrored');
 ok(d.caps['tsun_panel_power.pv5']===373.1&&d.caps['tsun_panel_energy.pv5']===1.06,'panel 5: '+d.caps['tsun_panel_power.pv5']+' W / '+d.caps['tsun_panel_energy.pv5']+' kWh');
 ok(d.caps.tsun_status==='Normal'&&d.caps['tsun_temperature.inverter']===73,'status Normal, temperature 73');
 ok(_trig.length===0,'no trigger on first state');
 // Underperformance: PV3 at 60 % for 20 min
 const t0=Date.now();const P=[350,355,210,348,370,345];
 for(let m=0;m<=20;m++)await d._checkPanels(P,t0+m*60000);
 const u=_trig.filter(t=>t.id==='panel_underperforming');
 ok(u.length===1&&u[0].tokens.panel===3,'PV3 underperformance triggered once: '+JSON.stringify(u[0]&&u[0].tokens));
 ok(d.isUnderperforming()===true,'Flow condition: true');
 await d._checkPanels([350,355,320,348,370,345],t0+22*60000); // -9 %: within hysteresis
 ok(_trig.filter(t=>t.id==='panel_recovered').length===0,'hysteresis: no recovery at -9 %');
 await d._checkPanels([350,355,345,348,370,345],t0+23*60000);
 ok(_trig.filter(t=>t.id==='panel_recovered').length===1&&!d.isUnderperforming(),'back to normal triggered');
 // 10-min passing shadow: no trigger
 const n0=_trig.length;for(let m=0;m<10;m++)await d._checkPanels([350,355,150,348,370,345],t0+(30+m)*60000);
 await d._checkPanels([350,355,345,348,370,345],t0+41*60000);ok(_trig.length===n0,'10-min shadow ignored');
 // Low sun: no check
 for(let m=0;m<30;m++)await d._checkPanels([60,60,10,60,60,60],t0+(50+m)*60000);ok(_trig.length===n0,'no check below 80 W average');
 // Status change
 setRegs({alarms:4});await d._poll();ok(d.caps.tsun_status==='Alarm 0x0004'&&d.caps.alarm_generic===true,'alarm: '+d.caps.tsun_status);
 ok(_trig.at(-1).id==='status_changed'&&_trig.at(-1).tokens.status==='Alarm 0x0004','status_changed trigger');
 setRegs({});await d._poll();
 // Standby
 state.up=false;for(let i=0;i<3;i++)await d._poll();
 ok(d.standby&&d.caps.measure_power===0&&d.caps['tsun_power.ac']===0&&d.caps['tsun_current.grid']===0&&d.caps['tsun_panel_power.pv2']===0&&d.caps.tsun_status==='Unreachable','logger lost while producing: power at 0, status Unreachable');
 ok(d.caps.meter_power===1321.1&&d.caps['tsun_energy.today']===5.73,'standby: counters kept');
 // Midnight
 day='2026-10-24';await d._poll();
 ok(d.caps['tsun_energy.today']===0&&d.caps['tsun_panel_energy.pv1']===0,'midnight: daily counters at 0');
 ok(JSON.stringify(Object.keys(d.store.staleToday))===JSON.stringify(['ac','pv1','pv2','pv3','pv4','pv5','pv6']),'previous day values stored');
 // Wake-up: inverter still returns previous day values
 state.up=true;setRegs({ac:15});await d._poll();
 ok(d.caps['tsun_energy.today']===0&&d.caps['tsun_panel_energy.pv3']===0&&!d.standby,'wake-up, inverter counter not yet reset: 0 shown');
 setRegs({ac:40,today:0.02,total:1321.12,pvDay:[0,0,0,0,0,0]});await d._poll();
 ok(d.caps['tsun_energy.today']===0.02&&d.caps['tsun_panel_energy.pv1']===0,'after inverter reset: '+d.caps['tsun_energy.today']);
 ok(Object.keys(d.store.staleToday).length===0,'previous day memory cleared');
 setRegs({ac:900,today:1.5,total:1322.6,pvDay:[.25,.25,.25,.25,.27,.25]});await d._poll();
 ok(d.caps['tsun_energy.today']===1.5&&d.caps['tsun_panel_energy.pv5']===0.27&&d.caps.meter_power===1322.6,'next day normal');
 // zero total meter at start-up: ignored
 setRegs({total:0});await d._poll();ok(d.caps.meter_power===1322.6,'meter_power never decreases');
 srv.close();
})().catch(e=>{console.error(e);process.exit(1)});
