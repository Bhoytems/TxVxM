document.addEventListener('DOMContentLoaded', function() {
    // Social media links
    const socialLinks = {
        instagram: "https://www.instagram.com/volublemanof9ja?igsh=Mjdib3RydmplZXVo",
        tiktok: "https://www.tiktok.com/@volublemanof9ja?_r=1&_d=ei3al4f7h6ljib&sec_uid=MS4wLjABAAAAWoJtQlXVudHJ0WjFM5AZR37lb_xds75zkf8k6aTl5IdRH35urbgxSZiWSdyfSkog&share_author_id=7440964022947759159&sharer_language=en&source=h5_m&u_code=ehcb994k38dd08&timestamp=1753629466&user_id=7440964022947759159&sec_user_id=MS4wLjABAAAAWoJtQlXVudHJ0WjFM5AZR37lb_xds75zkf8k6aTl5IdRH35urbgxSZiWSdyfSkog&utm_source=copy&utm_campaign=client_share&utm_medium=android&share_iid=7454575476699907845&share_link_id=d1d6603e-81ff-40ef-89dc-2078a9f1596b&share_app_id=1233&ugbiz_name=ACCOUNT&social_share_type=5&enable_checksum=1",
        twitter: "https://x.com/Volublemanof9ja?s=09"
        support: "https://www.profitableratecpm.com/gi6n5d2c?key=0f8b2aa1c7882ffec8c32dd1e3bde665"
    };
    
    // Add click events to buttons
    document.getElementById('instagram').addEventListener('click', function() {
        window.open(socialLinks.instagram, '_blank');
    });
    
    document.getElementById('tiktok').addEventListener('click', function() {
        window.open(socialLinks.tiktok, '_blank');
    });
    
    document.getElementById('twitter').addEventListener('click', function() {
        window.open(socialLinks.twitter, '_blank');
    });
 document.getElementById('support').addEventListener('click', function() {
        window.open(socialLinks.support, '_blank');
    });
    
    // Create floating particles
    const particlesContainer = document.getElementById('particles');
    const particleCount = 30;
    
    for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement('div');
        particle.classList.add('particle');
        
        // Random properties
        const size = Math.random() * 10 + 5;
        const posX = Math.random() * 100;
        const posY = Math.random() * 100;
        const delay = Math.random() * 5;
        const duration = Math.random() * 10 + 10;
        
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        particle.style.left = `${posX}%`;
        particle.style.top = `${posY}%`;
        particle.style.background = `rgba(255, 215, 0, ${Math.random() * 0.5 + 0.1})`;
        particle.style.animation = `float ${duration}s ease-in-out ${delay}s infinite`;
        particle.style.borderRadius = '50%';
        particle.style.position = 'absolute';
        
        particlesContainer.appendChild(particle);
    }
    
    // Logo hover effect
    const logo = document.getElementById('logo');
    logo.addEventListener('mouseenter', function() {
        this.style.transform = 'scale(1.05) rotate(5deg)';
    });
    
    logo.addEventListener('mouseleave', function() {
        this.style.transform = 'scale(1) rotate(0deg)';
    });
    
    // Button hover effects
    const buttons = document.querySelectorAll('.btn');
    buttons.forEach(button => {
        button.addEventListener('mouseenter', function() {
            this.style.transform = 'translateY(-3px)';
        });
        
        button.addEventListener('mouseleave', function() {
            this.style.transform = 'translateY(0)';
        });
    });
})
