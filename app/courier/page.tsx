import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/session';
import CourierDashboard from '@/components/courier-dashboard';
export default async function CourierPage(){const session=await currentSession();if(!session)redirect('/courier/login');if(session.role!=='courier')redirect('/');return <CourierDashboard/>;}
