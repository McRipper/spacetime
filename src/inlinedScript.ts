// eslint-disable-next-line @typescript-eslint/naming-convention
export default (document: any, window: any, Chart: any) => {
  const CHART_COLORS = [
    "rgb(250, 211, 144)",
    "rgb(248, 194, 145)",
    "rgb(106, 137, 204)",
    "rgb(130, 204, 221)",
    "rgb(184, 233, 148)",
    "rgb(246, 185, 59)",
    "rgb(229, 80, 57)",
    "rgb(74, 105, 189)",
    "rgb(96, 163, 188)",
    "rgb(120, 224, 143)",
    "rgb(250, 152, 58)",
    "rgb(235, 47, 6)",
    "rgb(30, 55, 153)",
    "rgb(60, 99, 130)",
    "rgb(56, 173, 169)",
    "rgb(229, 142, 38)",
    "rgb(183, 21, 64)",
    "rgb(12, 36, 97)",
    "rgb(10, 61, 98)",
  ];

  const escapeHtml = (str: string): string => {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  };

  const getTimeValue = (record: any, mode: string): number => {
    if (!record) { return 0; }
    if (typeof record === 'number') { return mode === 'editing' ? 0 : record; }
    return mode === 'editing' ? (record.editing || 0) : (record.total || 0);
  };

  const formatTime = (_time: number) => {
    const time = Math.round(_time);
    const hours = Math.floor(time / 60 / 60);
    const minutes = Math.floor((time - hours * 60 * 60) / 60);
    const minutesString = `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    if (time < 60) { return '< 1 minute'; }
    if (hours < 1) { return minutesString; }
    return `${hours} hour${hours !== 1 ? 's' : ''}${minutes ? `, ${minutesString}` : ''}`;
  };

  let currentChart: any;
  const renderChart = (startDate: string, endDate: string, group: string, mode: string) => {
    const startTimestamp = +new Date(startDate);
    const endTimestamp = +new Date(endDate);
    const timestamps: number[] = [];

    let currentTimestamp = startTimestamp;
    while (currentTimestamp <= endTimestamp) {
      timestamps.push(currentTimestamp);
      currentTimestamp += 86400000;
    }

    const buckets = timestamps.reduce<Record<string, boolean>>((acc, time) => {
      const date = new Date(time).toISOString().split('T')[0];
      const [year, month, day] = date.split('-');
      const groupDate = (() => {
        if (group === 'daily') { return [year, month, day].join('-'); }
        if (group === 'weekly') {
          const weekday = (new Date(time).getDay() + 6) % 7;
          return new Date(time - weekday * 86400000).toISOString().split('T')[0];
        }
        if (group === 'monthly') { return [year, month].join('-'); }
        return year;
      })();
      acc[groupDate] = true;
      return acc;
    }, {});

    const data = {
      labels: Object.keys(buckets).map((bucket) => {
        const isCurrentYear = new Date(bucket).getFullYear() === new Date().getFullYear();
        return (group === 'weekly' ? 'Week of ' : '') + new Date(bucket).toLocaleString('en-US', {
          day: group === 'daily' || group === 'weekly' ? 'numeric' : undefined,
          month: group === 'yearly' ? undefined : 'short',
          year: isCurrentYear && group !== 'yearly' ? undefined : 'numeric'
        });
      }),
      datasets: Object.keys(window.workspaceTimes).map((workspace, index) => ({
        label: workspace,
        data: Object.keys(buckets).map((bucket) =>
          timestamps
            .filter(timestamp => {
              if (group === 'weekly') {
                const weekday = (new Date(timestamp).getDay() + 6) % 7;
                return new Date(timestamp - weekday * 86400000).toISOString().split('T')[0].indexOf(bucket) === 0;
              }
              return new Date(timestamp).toISOString().split('T')[0].indexOf(bucket) === 0;
            })
            .reduce((acc, timestamp) => {
              const dateKey = new Date(timestamp).toISOString().split('T')[0];
              return acc + getTimeValue(window.workspaceTimes[workspace][dateKey], mode);
            }, 0)
        ),
        backgroundColor: CHART_COLORS[(index * 2) % CHART_COLORS.length]
      }))
    };

    const config = {
      type: 'bar' as const,
      data,
      options: {
        responsive: true,
        scales: {
          x: { stacked: true },
          y: {
            stacked: true,
            ticks: {
              callback: (value: number) => {
                if (!value) { return null; }
                return formatTime(Math.floor(value / 3600) * 3600);
              }
            }
          }
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: (tooltipItem: any) => {
                if (!tooltipItem.raw) { return null; }
                return `${tooltipItem.dataset.label}: ${formatTime(tooltipItem.raw)}`;
              }
            }
          }
        }
      }
    };

    if (currentChart) { currentChart.destroy(); }
    currentChart = new Chart(document.getElementById('chart'), config);
  };

  const renderTable = (startDate: string, endDate: string) => {
    const tbody = document.getElementById('table-body');
    const startTimestamp = +new Date(startDate);
    const endTimestamp = +new Date(endDate);
    tbody.innerHTML = '';

    Object.keys(window.workspaceTimes).forEach((workspace, index) => {
      let totalTime = 0;
      let editingTime = 0;

      Object.keys(window.workspaceTimes[workspace]).forEach((date) => {
        const timestamp = +new Date(date);
        if (timestamp < startTimestamp || timestamp > endTimestamp) { return; }
        const record = window.workspaceTimes[workspace][date];
        totalTime += getTimeValue(record, 'total');
        editingTime += getTimeValue(record, 'editing');
      });

      const pct = totalTime > 0 ? Math.round((editingTime / totalTime) * 100) : 0;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div class="workspace-color" style="background-color: ${CHART_COLORS[(index * 2) % CHART_COLORS.length]}"></div>
          ${escapeHtml(workspace)}
        </td>
        <td>${formatTime(totalTime)}</td>
        <td>${editingTime > 0 ? formatTime(editingTime) : '\u2014'}</td>
        <td>${editingTime > 0 ? pct + '%' : '\u2014'}</td>
      `;
      tbody.appendChild(tr);
    });
  };

  const render = () => {
    const startDate = document.getElementById('start').value;
    const endDate = document.getElementById('end').value;
    const group = document.getElementById('group').value;
    const mode = document.getElementById('mode').value;

    renderChart(startDate, endDate, group, mode);
    renderTable(startDate, endDate);
  };

  document.getElementById('start').addEventListener('change', render);
  document.getElementById('end').addEventListener('change', render);
  document.getElementById('group').addEventListener('change', render);
  document.getElementById('mode').addEventListener('change', render);
  render();
};
