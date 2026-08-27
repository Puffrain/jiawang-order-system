const dangerous=/^[=+\-@\t\r]/;
export function safeCsvCell(value:unknown){let text=String(value??"");if(dangerous.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`;}
export function makeCsv(headers:string[],rows:unknown[][]){return "\uFEFF"+[headers,...rows].map(row=>row.map(safeCsvCell).join(",")).join("\r\n");}
export function csvResponse(filename:string,csv:string){return new Response(csv,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="${filename}"`,"Cache-Control":"no-store"}});}
