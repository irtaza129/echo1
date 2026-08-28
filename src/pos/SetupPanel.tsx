import { useState } from 'react';
import SetupModules from './SetupModules';
import SetupTables  from './SetupTables';
import SetupStaff   from './SetupStaff';

// Everything that used to be a terminal command.
//
// Grouped behind one tab rather than scattered through the till, because these
// are things done once when the restaurant opens and then rarely — and because
// a cashier tapping "Modules" mid-service should not be able to switch the till
// off. The tab only renders for an account admin (see PosTerminal).

type Section = 'modules' | 'tables' | 'staff';

const SECTIONS: Array<{ id: Section; label: string; blurb: string }> = [
  { id: 'modules', label: 'What you use', blurb: 'Turn the till, table ordering, bookings and phone on or off' },
  { id: 'tables',  label: 'Tables & QR',  blurb: 'Add tables, create their codes, print the cards' },
  { id: 'staff',   label: 'Staff & PINs', blurb: 'Give each person a PIN and decide what they may do' },
];

export default function SetupPanel() {
  const [section, setSection] = useState<Section>('modules');
  const current = SECTIONS.find(s => s.id === section)!;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 mb-3">
        <div className="flex gap-2 flex-wrap mb-2">
          {SECTIONS.map(s => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`min-h-[44px] px-4 rounded-xl text-sm font-bold border cursor-pointer ${
                section === s.id
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white border-slate-300 hover:bg-slate-50'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">{current.blurb}</p>
      </div>

      <div className="flex-1 overflow-auto">
        {section === 'modules' && <SetupModules />}
        {section === 'tables'  && <SetupTables />}
        {section === 'staff'   && <SetupStaff />}
      </div>
    </div>
  );
}
