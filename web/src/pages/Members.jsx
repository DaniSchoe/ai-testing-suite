import { useState } from 'react';
import { can, PageHead, Tabs, useUser } from '../lib.jsx';
import Teams from './admin/Teams.jsx';
import Users from './admin/Users.jsx';

export default function Members() {
  const user = useUser();
  const [tab, setTab] = useState(can(user, 'users.manage') ? 'members' : 'teams');
  return (
    <>
      <PageHead title="Mitglieder & Teams">Wer in diesem Mandanten arbeitet, mit welcher Rolle und in welchen Teams. Rollen gelten pro Mandant; die Rollendefinitionen selbst sind global.</PageHead>
      <Tabs value={tab} onChange={setTab} tabs={[...(can(user, 'users.manage') ? [['members', 'Mitglieder']] : []), ['teams', 'Teams']]} />
      {tab === 'members' && <Users />}
      {tab === 'teams' && <Teams />}
    </>
  );
}
