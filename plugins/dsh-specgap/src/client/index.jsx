import React,{useSyncExternalStore} from 'react';
import {Workbench} from './Workbench.jsx';
import {ReportPane,ReportTitle,ReportError} from './ReportPane.jsx';
import {bootstrap} from './api.mjs';
import {createReportNavigation,REPORT_KIND,REPORT_ID} from './report-navigation.mjs';
import {reportCopy} from './report-copy.mjs';
import en from '../../locale/en-US.json';
import zh from '../../locale/zh-CN.json';
import css from './styles.css';
import reportCss from './report.css';
export const inject=['slots','layout','locale','sidebarRightTabs','sidebarRight','uiWorkspace'];
function WorkbenchEntry({navigation,t,...props}){
 const error=useSyncExternalStore(navigation.subscribe,navigation.getError,navigation.getError);
 return <div className="sg-workbench-entry">{error&&<ReportError t={t} error={error}/>}<Workbench t={t} {...props}/></div>;
}
function Icon(){return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M9 4H4v16h5M15 4h5v16h-5M8 12h8m-3-3 3 3-3 3"/></svg>;}
export function apply(ctx) {
  const {meta:enMeta,...enCopy}=en, {meta:zhMeta,...zhCopy}=zh;
  ctx.effect(()=>ctx.locale.register('specgap',{en:{...enCopy,...reportCopy.en},zh:{...zhCopy,...reportCopy.zh}}));
  const t=ctx.locale.bind('specgap');
  ctx.effect(()=>{const style=document.createElement('style');style.textContent=css+'\n'+reportCss;document.head.append(style);return ()=>style.remove();});
  ctx.effect(()=>{
    const navigation=createReportNavigation({bootstrap,layout:ctx.layout,uiWorkspace:ctx.uiWorkspace,sidebarRight:ctx.sidebarRight});
    const disposeType=ctx.sidebarRightTabs.register({id:REPORT_ID,kind:REPORT_KIND,title:()=>t('reportTitle'),keepMounted:true});
    const disposeBody=ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:REPORT_ID,locale:'specgap',inject:()=>({navigation})},ReportPane));
    const disposeTitle=ctx.slots.inject('sidebar.right.pane.tab.title',()=>ctx.slots.register({name:'sidebar.right.pane.tab.title',key:REPORT_ID,locale:'specgap'},ReportTitle));
    const disposeMain=ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'specgap',locale:'specgap',inject:()=>({back:()=>ctx.layout.selectPanel(null),openReport:navigation.openReport,initialSelection:navigation.getSelection(),onSelectionChange:navigation.remember,navigation})},WorkbenchEntry));
    const disposeEntry=ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'specgap',order:30,label:()=>t('panel'),locale:'specgap'},Icon));
    return ()=>{navigation.dispose();disposeBody();disposeTitle();disposeType();disposeMain();disposeEntry();};
  });
}
