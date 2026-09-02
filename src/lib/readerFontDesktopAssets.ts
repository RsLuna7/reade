// Desktop-only module: Vite can erase this entire dynamic-import branch from
// web builds while emitting the generated @font-face catalog and license notice
// for desktop builds.
import "../styles/reader-fonts.generated.css";
import licenseNoticeUrl from "../assets/reader-fonts/LICENSES.generated.txt?url";

export { licenseNoticeUrl };
