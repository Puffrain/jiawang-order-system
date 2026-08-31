import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/session';
import CourierAssignment from '@/components/admin/courier-assignment';
export default async function CourierAdminPage(){const session=await currentSession();if(!session)redirect('/admin/login?returnTo=/admin/couriers');if(session.role!=='owner')redirect('/');return <CourierAssignment/>;}
