
import { createFileRoute } from '@tanstack/react-router'
import CreatePSIForm from '../components/createPSIForm'
import JoinPSIForm from '../components/joinPSIForm'

export const Route = createFileRoute('/')({
  component: Home
})

function Home() {
  // const { state } = Route.useLoaderData();
  
  return (
    <div>
      <div
        className='new_psi'
        style={{width:"48%", float: "left"}}
      >
        <CreatePSIForm />
      </div>
      <div className='join_psi' style={{width:'48%', float:'right'}}>
        <JoinPSIForm />
      </div>
    </div>
  );
}
