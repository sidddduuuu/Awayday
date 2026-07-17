const journey = [
  { time: "10:40", label: "Meet", detail: "JFK Terminal 8", state: "done" },
  { time: "12:15", label: "Fly", detail: "Direct to Miami", state: "done" },
  { time: "15:32", label: "Arrive", detail: "MIA baggage claim", state: "active" },
  { time: "16:10", label: "Check in", detail: "Hotel near stadium", state: "next" },
  { time: "18:45", label: "Kickoff", detail: "Group at Gate 3", state: "next" },
] as const;

export default function Home() {
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Awayday home">Awayday<span>.</span></a>
        <nav aria-label="Trip sections">
          <a href="#journey">Journey</a>
          <a href="#rules">Rules</a>
        </nav>
        <div className="agent-status"><span aria-hidden="true" />Autopilot watching</div>
      </header>

      <section className="mission" id="top" aria-labelledby="mission-title">
        <div>
          <p className="context">Miami match · 5 travelers</p>
          <h1 id="mission-title">Get everyone there before kickoff.</h1>
          <p>Direct flights, refundable bookings, and one shared plan under $4,600.</p>
        </div>
        <div className="readiness" aria-label="Kickoff readiness 82 percent">
          <strong>82%</strong>
          <span>Kickoff readiness</span>
          <small>34 min arrival buffer</small>
        </div>
      </section>

      <div className="workspace">
        <section className="journey" id="journey" aria-labelledby="journey-title">
          <div className="section-heading">
            <div>
              <h2 id="journey-title">Shared arrival</h2>
              <p>One live path for the whole group</p>
            </div>
            <span className="live-label"><span aria-hidden="true" />Live</span>
          </div>

          <ol className="timeline">
            {journey.map((stop) => (
              <li className={stop.state} key={stop.label}>
                <time>{stop.time}</time>
                <span className="marker" aria-hidden="true" />
                <div>
                  <strong>{stop.label}</strong>
                  <span>{stop.detail}</span>
                </div>
              </li>
            ))}
          </ol>

          <div className="agent-note">
            <span className="agent-mark" aria-hidden="true">A</span>
            <div>
              <strong>Awayday is protecting a 34-minute buffer.</strong>
              <p>Traffic to the stadium is rising. I’m watching the transfer and will reroute the group if the buffer drops below 20 minutes.</p>
            </div>
          </div>
        </section>

        <aside id="rules" aria-labelledby="rules-title">
          <section className="rail-section budget">
            <div className="section-heading">
              <h2 id="rules-title">Trip guardrails</h2>
              <span>$3,940 / $4,600</span>
            </div>
            <div className="meter" role="progressbar" aria-label="Trip budget used" aria-valuemin={0} aria-valuemax={4600} aria-valuenow={3940}>
              <span />
            </div>
            <p>$660 remains for changes</p>
          </section>

          <section className="rail-section rules" aria-label="Active rules">
            <div><span>Refundable only</span><strong>Required</strong></div>
            <div><span>Flight stops</span><strong>Direct</strong></div>
            <div><span>Auto-approve</span><strong>Up to $120</strong></div>
          </section>

          <section className="rail-section activity" aria-labelledby="activity-title">
            <h2 id="activity-title">Latest action</h2>
            <time>2 min ago</time>
            <p>Rechecked traffic and kept the original transfer. No change needed.</p>
          </section>
        </aside>
      </div>
    </main>
  );
}

