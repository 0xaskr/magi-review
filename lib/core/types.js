/** Shared data contracts. This module has no runtime dependencies.
 * @typedef {'critical'|'high'|'medium'|'low'|'info'} Severity
 * @typedef {'high'|'medium'|'low'} Confidence
 * @typedef {'approve'|'request_changes'} Vote
 * @typedef {{path:string, side?:'old'|'new', line?:number, range?:{start:number,end:number}, hunkId?:string}} FindingLocation
 * @typedef {{kind:string,path?:string,line?:number,command?:string,exitCode?:number,outputDigest?:string,note:string}} FindingEvidence
 * @typedef {{id:string,fingerprint?:string,location?:FindingLocation,path?:string,severity:Severity,confidence:Confidence,category:string,title:string,rationale:string,suggestion?:string,mustFix:boolean,introducedByChange:boolean,evidence?:FindingEvidence[]}} SeatFinding
 * @typedef {SeatFinding & {fingerprint:string,sourceSeatRefs:string[],sourceFindingIds:string[],status:'blocking'|'non_blocking',mergeReason:string}} AggregatedFinding
 * @typedef {{seatRef:string,seatId?:string,perspective?:string,model?:{provider:string,model:string},status:'completed'|'error',verdict?:Vote,impact?:'major'|'normal',findings:SeatFinding[],summary:string,evidenceNote?:string,childSessionId?:string}} SeatBrief
 * @typedef {{seatRef:string,finalVerdict:Vote,finalImpact?:'major'|'normal',finalFindings:SeatFinding[],changedFromBrief?:boolean,changeReason?:string,reason?:string,summary?:string,status?:'completed'|'error'}} Ballot
 * @typedef {{seatId:string,seatRef?:string,status:'completed'|'error'}} Seat
 * @typedef {{approval?:'majority'|'unanimous',blockingSeverity?:Severity,escalateOnRisk?:boolean,escalatedBy?:'none'|'config'|'cli'}} Policy
 * @typedef {{partial?:boolean,interrupted?:boolean,totalFiles?:number,reviewedFiles?:number}} Coverage
 * @typedef {{seatRef:string,round:number,agreesWith?:{seatRef:string,reason:string}[],disagreesWith?:{seatRef:string,reason:string}[],positionChanged?:boolean,changeReason?:string,newFindings?:SeatFinding[],questions?:{to?:string,question:string}[]}} DiscussionResponse
 * @typedef {{index:number,responses:DiscussionResponse[]}} DiscussionRound
 * @typedef {{seatId:string,seatRef?:string,perspective?:string,label?:string,provider:string,model:string}} ModelAssignment
 * @typedef {{at:'verdict',seats:{seatRef:string,seatId:string,perspective:string,provider:string,model:string,briefVerdict?:Vote,finalVerdict?:Vote,changed:boolean}[]}} RevealInfo
 * @typedef {{seatRef:string,verdict:string,reason:string}} Dissent
 * @typedef {{verdict:'approve'|'request_changes'|'insufficient'|'none',status:'completed'|'degraded'|'error',trust:'trustworthy'|'needs_review'|'untrustworthy',declaredPolicy:'majority'|'unanimous',effectivePolicy:'majority'|'unanimous',escalatedBy:'none'|'config'|'cli'|'risk',approveVotes:number,requestVotes:number,expectedQuorum:number,blockingFindings:AggregatedFinding[],dissent:Dissent[],rationale:string,overallImpact:'major'|'normal'|'unknown'}} Decision
 * @typedef {{seats:Seat[],ballots:Ballot[],findings?:AggregatedFinding[],coverage?:Coverage,degradedReasons?:string[],policy?:Policy,risk?:{level:string},interrupted?:boolean}} DecisionInput
 * @typedef {{reviewId:string,mode:'quick'|'council',status:Decision['status'],trust:Decision['trust'],verdict:Decision['verdict'],overallImpact:Decision['overallImpact'],summary:string,seats:{seatId:string,label:string,verdict?:string,changed?:boolean,status:string}[],counts:{findings:number,blocking:number},target:{kind:string,baseRef?:string,files:number,partial:boolean},homogeneous:boolean,rounds:number,durationMs:number,degradedReasons:string[],reportId:string,approveVotes?:number,requestVotes?:number,findings?:AggregatedFinding[]}} ReviewDigest
 * @typedef {{digest?:ReviewDigest,reviewId?:string,reportId?:string,mode?:'quick'|'council',status?:Decision['status'],trust?:Decision['trust'],verdict?:Decision['verdict'],overallImpact?:Decision['overallImpact'],decision?:Partial<Decision>,scope?:{target?:{kind:string,baseRef?:string},files?:string[]},target?:{kind:string,baseRef?:string,files?:unknown[]},coverage?:Coverage,risk?:{level:string},reveal?:RevealInfo,findings?:AggregatedFinding[],seatBriefs?:SeatBrief[],discussion?:DiscussionRound[],ballots?:Ballot[],degradedReasons?:string[],metadata?:{startedAt?:string,finishedAt?:string,durationMs?:number,homogeneous?:boolean},durationMs?:number,homogeneous?:boolean}} ReviewResult
 * @typedef {{summary:string,seatSummaries:{seatId:string,label:string,view:string}[],consensus:{fingerprint:string,statement:string}[],disputes:{fingerprint?:string,seats:string[],point:string,resolved:boolean}[],voteChanges:{seatId:string,from:string,to:string,reason:string}[],unresolvedQuestions:{from:string,to?:string,question:string}[],evidenceStrength:'strong'|'moderate'|'weak',dissent:{seatId:string,verdict:string,reason:string}[],minutesStatus:'ok'|'invalid'}} CouncilMinutes
 */
export {};
