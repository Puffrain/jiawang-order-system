import db from "@/lib/db";

export function refreshProfileCompletion(userId:string){
  const profile=db.prepare(`SELECT u.display_name displayName,p.shop_name shopName FROM users u LEFT JOIN customer_profile p ON p.user_id=u.id WHERE u.id=? AND u.role='buyer'`).get(userId) as {displayName:string|null;shopName:string|null}|undefined;
  const addressCount=(db.prepare("SELECT COUNT(*) count FROM addresses WHERE user_id=?").get(userId) as {count:number}).count;
  const completed=Boolean(profile?.displayName?.trim()&&profile?.shopName?.trim()&&addressCount>0);
  const hasUpdatedAt=(db.prepare("PRAGMA table_info(customer_profile)").all() as Array<{name:string}>).some(column=>column.name==="updated_at");
  db.prepare(`INSERT INTO customer_profile(user_id,profile_completed) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET profile_completed=excluded.profile_completed${hasUpdatedAt?",updated_at=CURRENT_TIMESTAMP":""}`).run(userId,completed?1:0);
  return completed;
}

export function buyerProfile(userId:string){
  const profile=db.prepare(`SELECT u.id,u.phone,u.display_name displayName,p.shop_name shopName,p.business_type businessType,p.profile_completed profileCompleted FROM users u LEFT JOIN customer_profile p ON p.user_id=u.id WHERE u.id=? AND u.role='buyer'`).get(userId) as {id:string;phone:string;displayName:string|null;shopName:string|null;businessType:string|null;profileCompleted:number}|undefined;
  if(!profile)return null;
  const addressCount=(db.prepare("SELECT COUNT(*) count FROM addresses WHERE user_id=?").get(userId) as {count:number}).count;
  return {...profile,profileCompleted:Boolean(profile.profileCompleted&&addressCount>0),addressCount};
}
