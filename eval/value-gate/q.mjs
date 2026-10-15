import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.argv[2],{readOnly:true});
const r=db.prepare(process.argv[3]).all();console.log(JSON.stringify(r,null,1));
