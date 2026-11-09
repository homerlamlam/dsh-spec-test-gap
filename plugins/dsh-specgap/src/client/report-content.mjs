// Deliberately small, inert Markdown subset. No HTML, links, images, URL
// navigation, or DOM HTML parser. Raw source is always available alongside it.
const entity=value=>value.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#x27;':"'",'&#39;':"'"}[x]));
export function inlineParts(text){
 const parts=[];const pattern=/\\([\\`*_{}\[\]()#!|>+~.\-])|`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;let end=0,match;
 while((match=pattern.exec(text))){if(match.index>end)parts.push({type:'text',text:entity(text.slice(end,match.index))});parts.push({type:match[1]?'text':match[2]?'code':'strong',text:entity(match[1]||match[2]||match[3])});end=pattern.lastIndex;}
 if(end<text.length)parts.push({type:'text',text:entity(text.slice(end))});return parts;
}
export function markdownBlocks(markdown){
 const lines=String(markdown).replace(/\r\n?/g,'\n').split('\n'),blocks=[];let i=0;
 const row=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(cell=>cell.trim());
 while(i<lines.length){const line=lines[i];if(!line.trim()){i++;continue;}
  const fence=line.match(/^(`{3,}|~{3,})(.*)$/);if(fence){const content=[];i++;while(i<lines.length&&!lines[i].startsWith(fence[1]))content.push(lines[i++]);if(i<lines.length)i++;blocks.push({type:'code',text:content.join('\n'),language:fence[2].trim()});continue;}
  const heading=line.match(/^(#{1,6})\s+(.+)$/);if(heading){blocks.push({type:'heading',level:heading[1].length,text:heading[2]});i++;continue;}
  if(/^\s*[-*_]{3,}\s*$/.test(line)){blocks.push({type:'rule'});i++;continue;}
  if(line.includes('|')&&i+1<lines.length&&/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])){const header=row(line),rows=[];i+=2;while(i<lines.length&&lines[i].includes('|')&&lines[i].trim())rows.push(row(lines[i++]));blocks.push({type:'table',header,rows});continue;}
  if(/^[-*+]\s/.test(line)){const items=[];while(i<lines.length&&/^[-*+]\s/.test(lines[i]))items.push(lines[i++].replace(/^[-*+]\s/,''));blocks.push({type:'list',items});continue;}
  if(/^>\s?/.test(line)){const text=[];while(i<lines.length&&/^>\s?/.test(lines[i]))text.push(lines[i++].replace(/^>\s?/,''));blocks.push({type:'quote',text:text.join('\n')});continue;}
  const text=[line];i++;while(i<lines.length&&lines[i].trim()&&!/^(#{1,6}\s|[-*+]\s|>\s?|`{3,}|~{3,})/.test(lines[i]))text.push(lines[i++]);blocks.push({type:'paragraph',text:text.join('\n')});
 }
 return blocks;
}
export function searchJson(value,query,limit=200){
 const matches=[],needle=String(query).trim().toLowerCase();let truncated=false;
 if(!needle)return {matches,truncated};
 function visit(node,path,key='',parentMatch=false){
  if(truncated)return;
  const keyMatch=parentMatch||key.toLowerCase().includes(needle),container=node!==null&&typeof node==='object';
  // A matched section exposes bounded leaf values, not repeated whole subtrees.
  if(container){const entries=Object.entries(node);if(entries.length){for(const [name,item] of entries){const next=Array.isArray(node)?`${path}[${name}]`:/^[A-Za-z_$][\w$]*$/.test(name)?`${path}.${name}`:`${path}[${JSON.stringify(name)}]`;visit(item,next,name,keyMatch);if(truncated)break;}return;}}
  if(keyMatch||(!container&&String(node).toLowerCase().includes(needle))){if(matches.length===limit){truncated=true;return;}matches.push({path,value:node});}
 }
 visit(value,'$');return {matches,truncated};
}
export function safeFilename(filename,format){const extension=format==='json'?'json':'md';return typeof filename==='string'&&filename.length<180&&new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.-]*\\.${extension}$`).test(filename)?filename:`specgap-report.${extension}`;}
