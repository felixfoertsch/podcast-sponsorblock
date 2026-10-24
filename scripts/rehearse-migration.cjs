const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {migrateCopy,openMigrationDatabase,sha256}=require('../dist/src/migration.js');
const root=process.argv[2];
const old=new Database(path.join(root,'archive/config/absdatabase.sqlite'),{readonly:true});
const shows=old.prepare("SELECT p.id,p.feedURL,l.extraData FROM podcasts p JOIN libraryItems l ON l.mediaId=p.id AND l.mediaType='podcast'").all().map(x=>({id:x.id,feedUrl:x.feedURL,consent:JSON.parse(x.extraData||'{}').adAnalysisEnabled===true}));
const episodes=old.prepare('SELECT id,podcastId,extraData,enclosureURL FROM podcastEpisodes').all().map(x=>{const data=JSON.parse(x.extraData||'{}');return{id:x.id,showId:x.podcastId,guid:data.guid??null,enclosureUrl:x.enclosureURL,sourceSha256:data.adAnalysis?.sourceSha256??null,analysis:data.adAnalysis??null};});
old.close();
const debug=new Database(path.join(root,'archive/config/debug-overlay.sqlite'),{readonly:true});
const debugRecords=['notes','sub_items','sub_item_status'].flatMap(table=>debug.prepare('SELECT * FROM '+table).all().map(row=>({table,row})));debug.close();
const input={shows,episodes,corpusDir:path.join(root,'archive/metadata/ad-analysis-corpus'),debugRecords};
for(const target of ['stable','experiment']){
	const catalog=JSON.parse(fs.readFileSync(path.join(root,target==='experiment'?'experiment-catalog-v2.json':'stable-catalog.json')));
	const db=openMigrationDatabase(path.join(root,target+'-rehearsal-v2.sqlite'));
	const bytes=Buffer.from(JSON.stringify({shows,episodes,target}));
	const first=migrateCopy(input,catalog.shows,catalog.episodes,db,bytes);
	const second=migrateCopy(input,catalog.shows,catalog.episodes,db,bytes);assert.equal(second.repeated,true);
	const report={target,sourceShows:shows.length,sourceEpisodes:episodes.length,targetShows:catalog.shows.length,targetEpisodes:catalog.episodes.length,matchedShows:db.prepare("SELECT count(*) n FROM psb_migration_show_map WHERE state='matched'").get().n,matchedEpisodes:first.matches.filter(m=>m.stableEpisodeId).length,conflicts:first.matches.filter(m=>m.reason==='conflict').length,unmatched:first.matches.filter(m=>m.reason==='unmatched').length,corpusArchived:db.prepare('SELECT count(*) n FROM psb_migration_corpus_archive').get().n,debugArchived:db.prepare('SELECT count(*) n FROM psb_migration_debug_archive').get().n,applicable:db.prepare('SELECT count(*) n FROM psb_migration_episode_map WHERE applicable=1').get().n,receiptCount:db.prepare('SELECT count(*) n FROM psb_migration_receipts').get().n,secondRunRepeated:second.repeated,integrity:db.pragma('integrity_check',{simple:true}),foreignKeyViolations:db.pragma('foreign_key_check').length};
	assert.equal(report.integrity,'ok');assert.equal(report.foreignKeyViolations,0);
	fs.writeFileSync(path.join(root,target+'-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));db.close();
}
