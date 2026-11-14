import { useEffect, useRef } from 'react'
import { LearnLinks } from './DataLinks'

const REPO_URL = 'https://github.com/mitri24/loop-the-difference'

type Props = { open: boolean; onClose: () => void }

// Dependency-free modal: the native <dialog> handles Esc and focus; a click on the backdrop closes it.
export function AboutPanel({ open, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="about"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="about-body">
        <div className="about-head">
          <h2>About Loop the Difference</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <h3>What it does</h3>
        <p>
          Loop the Difference shows NASA SPHEREx images of one patch of sky over time. Enter a position
          or a target name, and the tool fetches every SPHEREx exposure of that patch from the IRSA
          archive, aligns them on one grid and plays them as a blink. Things that move or change stand
          out; things that stay the same disappear into the background.
        </p>

        <h3>How to read the blink</h3>
        <p>
          Stars that do not move stay still; a dot that jumps between dates is a candidate for motion —
          check it against the catalogues before calling it anything. Compare only comparable frames:
          same detector, similar coverage. SPHEREx observes through linear variable filters, so the
          exact wavelength differs from frame to frame, and a brightness change can be a wavelength
          change.
        </p>

        <h3>How to read the difference</h3>
        <p>
          In the difference view grey means no change, red was brighter in the earlier visit, blue in
          the later one. Differences are formed only between epoch stacks of the same detector.
        </p>

        <p className="caveat">
          Loop the Difference is a discovery aid – every change it shows is a candidate that needs
          checking against the catalogues before it counts as anything. It never claims a discovery.
        </p>

        <h3>Learn and reproduce</h3>
        <LearnLinks />

        <h3>Data and credits</h3>
        <ul className="credits">
          <li>
            <strong>SPHEREx images</strong> – NASA/IPAC Infrared Science Archive (IRSA), via the IRSA
            SIA2 search and cutout services. “This publication makes use of data products from the
            Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer
            (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California
            Institute of Technology, and is funded by the National Aeronautics and Space
            Administration.” – “This research has made use of the NASA/IPAC Infrared Science Archive,
            which is funded by the National Aeronautics and Space Administration and operated by the
            California Institute of Technology.”{' '}
            <a href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noreferrer">
              SPHEREx at IRSA
            </a>{' '}
            ·{' '}
            <a href="https://irsa.ipac.caltech.edu/ack.html" target="_blank" rel="noreferrer">
              IRSA acknowledgements
            </a>
          </li>
          <li>
            <strong>Sky context</strong> –{' '}
            <a href="https://aladin.cds.unistra.fr/AladinLite/" target="_blank" rel="noreferrer">
              Aladin Lite
            </a>
            , developed at CDS, Strasbourg Observatory, France (Boch &amp; Fernique 2014; Baumann et
            al. 2022), LGPL-3.0-or-later. Target names are resolved with Sesame (CDS). HiPS sky surveys
            come from CDS and the mirrors at ESA ESDC and NASA/IPAC IRSA.
          </li>
          <li>
            <strong>AllWISE sky layer</strong> – “This publication makes use of data products from the
            Wide-field Infrared Survey Explorer, which is a joint project of the University of
            California, Los Angeles, and the Jet Propulsion Laboratory/California Institute of
            Technology, funded by the National Aeronautics and Space Administration.”{' '}
            <a href="https://wise2.ipac.caltech.edu/docs/release/allwise/" target="_blank" rel="noreferrer">
              AllWISE release
            </a>
          </li>
          <li>
            <strong>ESA Gaia DR3</strong> (proper motions, when a named target is looked up) – “This
            work has made use of data from the European Space Agency (ESA) mission Gaia
            (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis
            Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the
            DPAC has been provided by national institutions, in particular the institutions
            participating in the Gaia Multilateral Agreement.”{' '}
            <a href="https://www.cosmos.esa.int/web/gaia-users/license" target="_blank" rel="noreferrer">
              Gaia data licence
            </a>
          </li>
          <li>
            <strong>Catalogue layers on the sky</strong> – Gaia DR3 (ESA) and AllWISE (NASA/IPAC)
            through VizieR, and SIMBAD: “This research has made use of the SIMBAD database and the
            VizieR catalogue access tool, CDS, Strasbourg Observatory, France.” Known asteroids from
            SkyBoT (IMCCE, Observatoire de Paris; Berthier et al. 2006).
          </li>
          <li>
            <strong>Detected sources</strong> – found in the SPHEREx frames with Photutils, an
            Astropy package for detection and photometry of astronomical sources (Bradley et al.),
            and compared with ESA Gaia DR3 and with AllWISE from NASA/IPAC IRSA.
          </li>
          <li>
            <strong>Known asteroids and comets</strong> – NASA/JPL Solar System Dynamics,
            Small-Body Identification API (SBIdent).
          </li>
          <li>
            <strong>Code</strong> – free software under the GNU General Public License v3.0, written
            with Claude Code (Anthropic) under human review. Built for NASA Space Apps 2026.{' '}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              Source on GitHub
            </a>
          </li>
        </ul>
      </div>
    </dialog>
  )
}
